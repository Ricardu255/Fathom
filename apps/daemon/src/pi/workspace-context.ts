import { open, stat } from "node:fs/promises";
import { resolveWorkspacePath } from "@harness/policy";

/** AGENTS.md 最多注入 16 KiB，避免超大文件挤占上下文。 */
export const MAX_AGENTS_CONTEXT_BYTES = 16 * 1024;

/**
 * 读取 workspace 根目录的 AGENTS.md。路径走与文件工具相同的 realpath/越界检查；
 * 文件缺失、不可读、不是普通文件时返回 null，不影响 Session 打开。
 */
export async function loadAgentsContext(
  workspaceRoot: string,
  protectedPaths?: readonly string[],
): Promise<string | null> {
  let target: string;
  try {
    target = await resolveWorkspacePath({
      allowMissing: true,
      path: "AGENTS.md",
      ...(protectedPaths === undefined ? {} : { protectedPaths }),
      workspaceRoot,
    });
  } catch {
    return null;
  }

  try {
    const info = await stat(target);
    if (!info.isFile() || info.size === 0) return null;
    const length = Math.min(info.size, MAX_AGENTS_CONTEXT_BYTES);
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (text === "") return null;
      return info.size > MAX_AGENTS_CONTEXT_BYTES
        ? `${text}\n\n（AGENTS.md 已按 ${MAX_AGENTS_CONTEXT_BYTES} 字节上限截断）`
        : text;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
