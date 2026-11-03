import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { assessCommand } from "@harness/policy";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const runCommandSchema = z.object({
  command: z.string().min(1).max(65_536).describe("在 workspace 根目录通过 Shell 执行的命令"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("超时时间，默认 120 秒"),
});

export interface SandboxedCommandOutput {
  code: number | null;
  note: string | null;
  stderr: string;
  stdout: string;
}

export type SandboxCommandRunner = (input: {
  command: string;
  cwd: string;
  onOutput?: (chunk: string) => void;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<SandboxedCommandOutput | null>;

/**
 * 命令执行始终需要用户审批。输出与退出码会作为工具结果回填给模型；
 * 非零退出码标记为 isError，但不会中断 Agent 循环。
 */
export function createRunCommandTool(runner?: SandboxCommandRunner): Tool {
  return {
    description:
      "在 workspace 根目录执行 Shell 命令。每次调用都需要用户审批；返回 stdout、stderr 与退出码。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = runCommandSchema.parse(input);
      const assessment = assessCommand(parsed.command);
      if (runner !== undefined) {
        const sandboxed = await runner({
          command: parsed.command,
          cwd: context.workspaceRoot,
          signal: context.signal,
          timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (sandboxed !== null) {
          return {
            content: formatResult(
              parsed.command,
              sandboxed.code,
              sandboxed.stdout,
              sandboxed.stderr,
              sandboxed.note,
              assessment.destructive,
            ),
            ...(sandboxed.code === 0 ? {} : { isError: true }),
          };
        }
      }
      return executeCommand(
        parsed.command,
        parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        assessment.destructive,
        context,
      );
    },
    inputSchema: toJsonSchema(runCommandSchema),
    name: "run_command",
    parse: (input) => runCommandSchema.parse(input),
    requiresApproval: true,
    summarize: (input) => {
      const parsed = runCommandSchema.parse(input);
      const assessment = assessCommand(parsed.command);
      return `${assessment.destructive ? "[高风险] " : ""}${assessment.summary}`;
    },
  };
}

export const runCommandTool = createRunCommandTool();

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

async function executeCommand(
  command: string,
  timeoutMs: number,
  destructive: boolean,
  context: ToolContext,
): Promise<ToolResult> {
  context.signal.throwIfAborted();
  const child = spawn(command, {
    cwd: context.workspaceRoot,
    detached: process.platform !== "win32",
    env: process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;

  const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
    if (outputBytes >= MAX_OUTPUT_BYTES) return;
    const text = chunk.toString("utf8");
    if (target === "stdout") stdout += text;
    else stderr += text;
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
      stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    }
  };

  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

  const killTree = () => killProcessTree(child.pid);
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree();
  }, timeoutMs);
  const onAbort = () => killTree();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );

    if (context.signal.aborted) throw new Error("命令已取消");
    if (timedOut) {
      return {
        content: formatResult(command, null, stdout, stderr, `超时（${timeoutMs}ms）`, destructive),
        isError: true,
      };
    }
    const isError = result.code !== 0;
    return {
      content: formatResult(
        command,
        result.code,
        stdout,
        stderr,
        result.signal ? `signal ${result.signal}` : null,
        destructive,
      ),
      ...(isError ? { isError: true } : {}),
    };
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null) killTree();
  }
}

function formatResult(
  command: string,
  code: number | null,
  stdout: string,
  stderr: string,
  note: string | null,
  destructive: boolean,
): string {
  const parts = [`$ ${command}`, ""];
  if (destructive) parts.push("[高风险命令，已由用户审批]", "");
  parts.push(`[退出码: ${code ?? "未知"}${note === null ? "" : ` · ${note}`}]`);
  if (stdout.trim()) parts.push("", "[stdout]", stdout.trimEnd());
  if (stderr.trim()) parts.push("", "[stderr]", stderr.trimEnd());
  if (!stdout.trim() && !stderr.trim()) parts.push("", "(no output)");
  return parts.join("\n");
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 进程可能已经退出；忽略清理失败。
  }
}
