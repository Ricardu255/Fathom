import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PathPolicyErrorCode = "INVALID" | "OUTSIDE_WORKSPACE" | "PROTECTED";

export class PathPolicyError extends Error {
  public constructor(
    public readonly code: PathPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PathPolicyError";
  }
}

/** 判断 target 是否位于 root 内（两者都应是已解析的绝对路径）。 */
export function isPathWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

/**
 * 与路由器相同的方式解析真实路径：对已存在的祖先调用 realpath，
 * 再把不存在的尾部拼回去。allowMissing 时还会拒绝指向不存在目标的符号链接。
 */
export async function canonicalizePath(path: string, allowMissing: boolean): Promise<string> {
  let current = path;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!allowMissing || !isNodeError(error) || error.code !== "ENOENT") {
        throw new PathPolicyError("INVALID", "路径不存在或无法访问");
      }

      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new PathPolicyError("INVALID", "拒绝写入目标不存在的符号链接");
        }
      } catch (lstatError: unknown) {
        if (!isNodeError(lstatError) || lstatError.code !== "ENOENT") throw lstatError;
      }

      const parent = dirname(current);
      if (parent === current) throw new PathPolicyError("INVALID", "无法解析目标路径");
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

export interface ResolveWorkspacePathInput {
  allowMissing?: boolean;
  path: string;
  protectedPaths?: readonly string[];
  workspaceRoot: string;
}

/**
 * 在审批前和执行前复用同一套真实路径检查。
 * 返回值为规范化后的绝对路径，调用方必须使用返回值而不是原始输入。
 */
export async function resolveWorkspacePath(input: ResolveWorkspacePathInput): Promise<string> {
  const requestedPath = input.path.trim();
  if (!requestedPath) throw new PathPolicyError("INVALID", "路径不能为空");

  const workspaceRoot = await canonicalizePath(resolve(input.workspaceRoot), false);
  const addressedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);

  if (!isPathWithin(workspaceRoot, addressedPath)) {
    throw new PathPolicyError("OUTSIDE_WORKSPACE", "拒绝访问 workspace 外部路径");
  }

  const target = await canonicalizePath(addressedPath, input.allowMissing ?? false);
  if (!isPathWithin(workspaceRoot, target)) {
    throw new PathPolicyError("OUTSIDE_WORKSPACE", "拒绝通过符号链接访问 workspace 外部路径");
  }

  for (const protectedPath of input.protectedPaths ?? []) {
    const canonicalProtectedPath = await canonicalizePath(resolve(protectedPath), true);
    if (isPathWithin(canonicalProtectedPath, target)) {
      throw new PathPolicyError("PROTECTED", "拒绝访问 daemon 受保护数据");
    }
  }

  return target;
}

export interface CommandAssessment {
  destructive: boolean;
  requiresApproval: boolean;
  summary: string;
}

const DESTRUCTIVE_COMMAND_PATTERN =
  /(?:^|[;&|\r\n]\s*)(?:sudo\s+)?(?:rm|rmdir|del|erase|rd|format|mkfs|shutdown|reboot)\b|git\s+(?:clean|reset\s+--hard|push\s+--force)/iu;

/** M1 中所有 Shell 命令都逐次审批；只额外标记高风险命令，便于 UI 强调。 */
export function assessCommand(command: string): CommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) throw new PathPolicyError("INVALID", "命令不能为空");
  if (trimmed.length > 65_536) throw new PathPolicyError("INVALID", "命令过长");

  const destructive = DESTRUCTIVE_COMMAND_PATTERN.test(trimmed);
  return {
    destructive,
    requiresApproval: true,
    summary: trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** 只接受简单命令；含 Shell 组合符、替换或重定向时返回 null。 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (trimmed === "" || trimmed.length > 8_192) return null;
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\n" || char === "\r") return null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/[\s;&|><`$()\n\r]/u.test(char)) {
      if (/\s/u.test(char)) {
        if (current !== "") {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      return null;
    }
    current += char;
  }
  if (escaped || quote !== null) return null;
  if (current !== "") tokens.push(current);
  return tokens.length === 0 ? null : tokens;
}

/** 生成可供“允许类似命令”使用的安全前缀；高风险或复杂命令不提供。 */
export function suggestCommandPrefix(command: string): string | null {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === null) return null;
  try {
    if (assessCommand(command).destructive) return null;
  } catch {
    return null;
  }
  const prefix = [tokens[0]];
  const second = tokens[1];
  if (second !== undefined && !second.startsWith("-")) prefix.push(second);
  const value = prefix.join(" ");
  return value.length <= 120 ? value : null;
}

export function validateCommandPrefix(prefix: string): boolean {
  const tokens = tokenizeSimpleCommand(prefix);
  return tokens !== null && tokens.length >= 1 && tokens.length <= 2 && prefix.length <= 120;
}

/** 完整命令必须仍以同一 token 前缀开始，且自身不是高风险命令。 */
export function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (!validateCommandPrefix(prefix)) return false;
  const commandTokens = tokenizeSimpleCommand(command);
  const prefixTokens = tokenizeSimpleCommand(prefix);
  if (commandTokens === null || prefixTokens === null) return false;
  try {
    if (assessCommand(command).destructive) return false;
  } catch {
    return false;
  }
  return prefixTokens.every((token, index) => commandTokens[index] === token);
}
