import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * 进程级文件写协调器：所有 Agent（父 Session、子 Agent、DAG worker）共享同一个实例。
 * 1. 同一 realpath 的写入串行，避免 DAG 并行节点互相覆盖。
 * 2. 记录模型读到的内容指纹；写入前若目标已被其他执行改变，返回 WORKSPACE_CHANGED。
 * Shell 命令不走这个锁，也不假装提供事务隔离。
 */
export class WorkspaceWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly observed = new Map<string, string>();

  public getObserved(path: string): string | undefined {
    return this.observed.get(path);
  }

  public observe(path: string, hash: string): void {
    this.observed.set(path, hash);
  }

  public reset(): void {
    this.tails.clear();
    this.observed.clear();
  }

  public async withLock<T>(
    path: string,
    signal: AbortSignal | undefined,
    execute: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(path, tail);
    await previous;
    signal?.throwIfAborted();
    try {
      signal?.throwIfAborted();
      return await execute();
    } finally {
      release?.();
      void tail.finally(() => {
        if (this.tails.get(path) === tail) this.tails.delete(path);
      });
    }
  }
}

/** 所有 Agent 共享的写协调器；测试可自行 new 一个隔离实例。 */
export const workspaceWriteCoordinator = new WorkspaceWriteCoordinator();

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashExistingFile(path: string): Promise<string | null> {
  try {
    return hashContent(await readFile(path));
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function assertObservedUnchanged(
  coordinator: WorkspaceWriteCoordinator,
  path: string,
): Promise<void> {
  const observed = coordinator.getObserved(path);
  if (observed === undefined) return;
  const current = await hashExistingFile(path);
  if (current !== observed) {
    throw new Error("WORKSPACE_CHANGED: 目标文件已被其他执行修改；请重新读取后再写入。");
  }
}
