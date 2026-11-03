import type { HarnessEvent, HarnessEventType } from "./events";
import { randomUUID } from "./random-uuid";

export interface EventDraft<T = unknown> {
  data: T;
  runId: string | null;
  type: HarnessEventType;
}

export type HarnessEventSink = (event: HarnessEvent) => Promise<void> | void;

/**
 * 单 Session 的事件序号与写入队列。
 * seq 在入队时立即分配：即使某次持久化失败，也只会留下空号，不会与已落盘事件冲突。
 * tail 始终吞掉 rejection，避免一次失败让后续所有事件都无法提交。
 */
export class SessionEventEmitter {
  private nextSeq: number;
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly sessionId: string,
    initialSeq: number,
    private readonly sink: HarnessEventSink,
  ) {
    this.nextSeq = initialSeq;
  }

  public get lastSeq(): number {
    return this.nextSeq;
  }

  public setLastSeq(seq: number): void {
    this.nextSeq = Math.max(this.nextSeq, seq);
  }

  public emit<T>(draft: EventDraft<T>): Promise<HarnessEvent<T>> {
    this.nextSeq += 1;
    const event: HarnessEvent<T> = {
      data: draft.data,
      id: randomUUID(),
      runId: draft.runId,
      seq: this.nextSeq,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      type: draft.type,
    };
    const operation = this.tail.then(async () => {
      await this.sink(event);
      return event;
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
