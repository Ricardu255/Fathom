import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileChange, HarnessEvent } from "@harness/core";
import { HarnessEventType } from "@harness/core";
import { resolveWorkspacePath } from "@harness/policy";

const MAX_FILE_BYTES = 1024 * 1024;

export type FileChangeAction = "replay" | "undo";

export class FileChangeServiceError extends Error {
  public constructor(
    public readonly code: "CONFLICT" | "INVALID" | "NOT_FOUND" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "FileChangeServiceError";
  }
}

interface FileChangePlan {
  absolutePath: string;
  expectedCurrent: string | null;
  path: string;
  target: string | null;
}

/** 基于 file.changed 的 before/after 撤销或重放整条会话的文件变更。 */
export class FileChangeService {
  public constructor(private readonly options: { protectedPaths: readonly string[] }) {}

  public async apply(
    workspaceRoot: string,
    events: readonly HarnessEvent[],
    paths: readonly string[],
    action: FileChangeAction,
  ): Promise<string[]> {
    const uniquePaths = [
      ...new Set(paths.map((path) => path.trim()).filter((path) => path !== "")),
    ];
    if (uniquePaths.length === 0) throw new FileChangeServiceError("INVALID", "至少选择一个文件");
    if (uniquePaths.length > 50)
      throw new FileChangeServiceError("INVALID", "一次最多处理 50 个文件");

    const plans: FileChangePlan[] = [];
    for (const path of uniquePaths) {
      const absolutePath = await this.resolve(workspaceRoot, path);
      plans.push(this.plan(events, path, absolutePath, action));
    }

    // 先验证所有文件的当前内容，再统一写入；任何冲突都不会产生部分写入。
    for (const plan of plans) {
      const current = await this.readCurrent(plan.absolutePath, plan.path);
      if (current !== plan.expectedCurrent) {
        throw new FileChangeServiceError(
          "CONFLICT",
          `文件已被修改，拒绝${action === "undo" ? "撤销" : "重放"}：${plan.path}`,
        );
      }
    }
    for (const plan of plans) {
      await this.writeCurrent(plan.absolutePath, plan.target);
    }
    return plans.map((plan) => plan.path);
  }

  private plan(
    events: readonly HarnessEvent[],
    path: string,
    absolutePath: string,
    action: FileChangeAction,
  ): FileChangePlan {
    const changes = changesForPath(events, path);
    const first = changes[0];
    const last = changes.at(-1);
    if (first === undefined || last === undefined) {
      throw new FileChangeServiceError("NOT_FOUND", `没有找到文件变更记录：${path}`);
    }
    return {
      absolutePath,
      expectedCurrent: action === "undo" ? last.after : first.before,
      path,
      target: action === "undo" ? first.before : last.after,
    };
  }

  private async resolve(workspaceRoot: string, path: string): Promise<string> {
    try {
      return await resolveWorkspacePath({
        allowMissing: true,
        path,
        protectedPaths: this.options.protectedPaths,
        workspaceRoot,
      });
    } catch (error: unknown) {
      throw new FileChangeServiceError(
        "INVALID",
        error instanceof Error ? error.message : `无法访问文件：${path}`,
      );
    }
  }

  private async readCurrent(absolutePath: string, path: string): Promise<string | null> {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) throw new FileChangeServiceError("INVALID", `目标不是文件：${path}`);
      if (info.size > MAX_FILE_BYTES) {
        throw new FileChangeServiceError("TOO_LARGE", `文件超过 1MB：${path}`);
      }
      const buffer = await readFile(absolutePath);
      if (buffer.includes(0)) {
        throw new FileChangeServiceError("INVALID", `二进制文件不能撤销/重放：${path}`);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error: unknown) {
      if (
        error instanceof FileChangeServiceError ||
        !isNodeError(error) ||
        error.code !== "ENOENT"
      ) {
        if (error instanceof FileChangeServiceError) throw error;
        throw new FileChangeServiceError("INVALID", `无法读取文件：${path}`);
      }
      return null;
    }
  }

  private async writeCurrent(absolutePath: string, content: string | null): Promise<void> {
    if (content === null) {
      await rm(absolutePath, { force: true });
      return;
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporary = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, absolutePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function changesForPath(events: readonly HarnessEvent[], path: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const event of events) {
    if (event.type !== HarnessEventType.FILE_CHANGED) continue;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const change = data as Partial<FileChange>;
    if (change.path !== path || typeof change.diff !== "string") continue;
    const before = change.before === undefined ? null : change.before;
    const after = change.after === undefined ? null : change.after;
    if (
      (before !== null && typeof before !== "string") ||
      (after !== null && typeof after !== "string")
    ) {
      continue;
    }
    changes.push({ after, before, diff: change.diff, path });
  }
  return changes;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
