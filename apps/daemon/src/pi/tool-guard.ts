import type { ToolResult } from "@harness/core";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENCY = 4;

/** 同参数副作用工具在这些名字下会去重；读工具每次都重新执行。 */
const SIDE_EFFECT_TOOLS = new Set([
  "edit_file",
  "forget_memory",
  "run_command",
  "run_workflow",
  "save_memory",
  "spawn_agent",
  "start_background_command",
  "write_file",
]);

export class ToolExecutionGuardError extends Error {
  public constructor(
    public readonly code: "ABORTED" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionGuardError";
  }
}

export interface ToolExecutionGuardOptions {
  maxConcurrency?: number;
  timeoutMs?: number;
}

/**
 * 工具执行的横切保护：并发上限、单次超时、同参数副作用去重。
 * 失败结果不会缓存；新 Run 开始时由调用方 reset() 清空去重表。
 */
export class ToolExecutionGuard {
  private readonly completed = new Map<string, ToolResult>();
  private readonly inFlight = new Map<string, Promise<ToolResult>>();
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(options: ToolExecutionGuardOptions = {}) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  public reset(): void {
    this.completed.clear();
    this.inFlight.clear();
  }

  public async run(
    toolName: string,
    input: unknown,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const dedupe = SIDE_EFFECT_TOOLS.has(toolName);
    const key = `${toolName}:${stableStringify(input)}`;
    if (dedupe) {
      const cached = this.completed.get(key);
      if (cached !== undefined) return cached;
      const pending = this.inFlight.get(key);
      if (pending !== undefined) return await pending;
    }

    const operation = this.runExclusive(signal, execute);
    if (dedupe) this.inFlight.set(key, operation);
    try {
      const result = await operation;
      if (dedupe && result.isError !== true) this.completed.set(key, result);
      return result;
    } finally {
      if (dedupe) this.inFlight.delete(key);
    }
  }

  private async runExclusive(
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<ToolResult>,
  ): Promise<ToolResult> {
    await this.acquire(signal);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ToolExecutionGuardError("TIMEOUT", "工具执行超时")),
        this.timeoutMs,
      );
    });
    const abortPromise =
      signal === undefined
        ? null
        : new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new ToolExecutionGuardError("ABORTED", "工具执行已中止"));
            signal.addEventListener("abort", onAbort, { once: true });
          });
    try {
      const races: Array<Promise<ToolResult>> = [execute(combined), timeoutPromise];
      if (abortPromise !== null) races.push(abortPromise);
      return await Promise.race(races);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      this.release();
    }
  }

  private async acquire(signal: AbortSignal | undefined): Promise<void> {
    while (this.active >= this.maxConcurrency) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new ToolExecutionGuardError("ABORTED", "工具执行已中止"));
        };
        const cleanup = () => {
          signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
        };
        this.waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.active += 1;
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
