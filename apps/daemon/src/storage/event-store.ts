import { mkdir, open, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessEvent } from "@harness/core";

export interface SessionEventStoreOptions {
  directory: string;
  onWarning?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * JSONL 是 Session 的事实来源。
 * - append 按 session 串行，写入后 sync；
 * - read 只解析完整行，读取期间新追加的部分行会被忽略，下次读取再看到；
 * - 不在运行期 truncate；启动修复单独调用 repairTrailingLine。
 */
export class SessionEventStore {
  private readonly tails = new Map<string, Promise<void>>();
  /** 同一个损坏行只隔离一次，否则每次读都会重复追加。 */
  private readonly quarantined = new Set<string>();

  public constructor(private readonly options: SessionEventStoreOptions) {}

  public async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
  }

  public async append(event: HarnessEvent): Promise<void> {
    await this.enqueue(event.sessionId, async () => {
      const handle = await open(this.pathFor(event.sessionId), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  public async read(sessionId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    const tail = this.tails.get(sessionId);
    if (tail !== undefined) await tail;

    let text: string;
    try {
      text = await readFile(this.pathFor(sessionId), "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    if (text.length === 0) return [];

    const hasTrailingNewline = text.endsWith("\n");
    const lines = text.split("\n");
    if (hasTrailingNewline) lines.pop();

    const events: HarnessEvent[] = [];
    const corrupt: Array<{ index: number; line: string }> = [];
    let previousSeq = 0;
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") {
        this.options.onWarning?.("忽略 JSONL 空行", { index, sessionId });
        continue;
      }
      let event: HarnessEvent;
      try {
        event = parseHarnessEvent(JSON.parse(line));
      } catch {
        const isLastLine = index === lines.length - 1 && !hasTrailingNewline;
        if (!isLastLine) {
          corrupt.push({ index, line });
          this.options.onWarning?.("忽略无法解析的 JSONL 行", { index, sessionId });
        }
        continue;
      }
      if (event.sessionId !== sessionId) {
        this.options.onWarning?.("忽略 sessionId 不匹配的事件", { index, sessionId });
        continue;
      }
      if (event.seq <= previousSeq) {
        this.options.onWarning?.("忽略非递增 seq 的事件", {
          index,
          seq: event.seq,
          sessionId,
        });
        continue;
      }
      previousSeq = event.seq;
      if (event.seq > afterSeq) events.push(event);
    }
    if (corrupt.length > 0) await this.quarantine(sessionId, corrupt);
    return events;
  }

  public async maxSeq(sessionId: string): Promise<number> {
    const events = await this.read(sessionId, 0);
    return events.at(-1)?.seq ?? 0;
  }

  /**
   * 启动时调用：如果最后一行缺少换行符，完整 JSON 则补换行，损坏则截断到最后完整行。
   * 运行期不要调用，避免与 append 竞争。
   */
  public async repairTrailingLine(sessionId: string): Promise<void> {
    const path = this.pathFor(sessionId);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (text.length === 0 || text.endsWith("\n")) return;

    const lastNewline = text.lastIndexOf("\n");
    const lastLine = text.slice(lastNewline + 1);
    try {
      parseHarnessEvent(JSON.parse(lastLine));
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile("\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      await truncate(path, lastNewline + 1);
      this.options.onWarning?.("已截断损坏的 JSONL 末行", { sessionId });
    }
  }

  public async remove(sessionId: string): Promise<void> {
    await rm(this.pathFor(sessionId), { force: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.options.directory, `${sessionId}.jsonl`);
  }

  /**
   * 损坏行不能只打一条 warning 就丢掉：事件流是事实源，丢了就再也拿不回来。
   * 这里把原始行追加到旁边的 .corrupt.jsonl，事后还能人工核对。
   */
  private async quarantine(
    sessionId: string,
    entries: ReadonlyArray<{ index: number; line: string }>,
  ): Promise<void> {
    const pending = entries.filter(({ line }) => !this.quarantined.has(`${sessionId}\n${line}`));
    if (pending.length === 0) return;
    const path = `${this.pathFor(sessionId).slice(0, -".jsonl".length)}.corrupt.jsonl`;
    const payload = `${pending
      .map(({ index, line }) => JSON.stringify({ index, line, quarantinedAt: Date.now() }))
      .join("\n")}\n`;
    try {
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      this.options.onWarning?.("隔离损坏行失败", {
        error: error instanceof Error ? error.message : String(error),
        path,
        sessionId,
      });
      return;
    }
    for (const { line } of pending) this.quarantined.add(`${sessionId}\n${line}`);
  }

  private async enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    try {
      await run;
    } finally {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

function parseHarnessEvent(value: unknown): HarnessEvent {
  if (!isPlainObject(value)) throw new Error("事件不是对象");
  const { data, id, runId, seq, sessionId, timestamp, type } = value;
  if (typeof id !== "string" || id.length === 0) throw new Error("事件 id 无效");
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) throw new Error("seq 无效");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("sessionId 无效");
  if (runId !== null && typeof runId !== "string") throw new Error("runId 无效");
  if (typeof type !== "string" || type.length === 0) throw new Error("type 无效");
  if (typeof timestamp !== "number") throw new Error("timestamp 无效");
  if (data === undefined) throw new Error("data 缺失");
  return { data, id, runId, seq, sessionId, timestamp, type: type as HarnessEvent["type"] };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
