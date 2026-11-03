import { type HarnessEvent, isTransientEventType } from "@harness/core";

export type SessionEventSubscriber = (event: HarnessEvent) => void;

const MAX_REPLAY_EVENTS = 512;

/** 进程内实时广播：持久化事件从 JSONL 重放，这里只缓存 transient 事件。 */
export class SessionEventBus {
  private readonly replay = new Map<string, HarnessEvent[]>();
  private readonly subscribers = new Map<string, Set<SessionEventSubscriber>>();

  public publish(event: HarnessEvent): void {
    if (isTransientEventType(event.type)) {
      const events = this.replay.get(event.sessionId) ?? [];
      events.push(event);
      if (events.length > MAX_REPLAY_EVENTS) {
        events.splice(0, events.length - MAX_REPLAY_EVENTS);
      }
      this.replay.set(event.sessionId, events);
    }
    for (const subscriber of this.subscribers.get(event.sessionId) ?? []) {
      subscriber(event);
    }
  }

  public replayAfter(sessionId: string, afterSeq: number): readonly HarnessEvent[] {
    return (this.replay.get(sessionId) ?? []).filter((event) => event.seq > afterSeq);
  }

  public subscribe(sessionId: string, subscriber: SessionEventSubscriber): () => void {
    const subscribers = this.subscribers.get(sessionId) ?? new Set<SessionEventSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  public clearSession(sessionId: string): void {
    this.replay.delete(sessionId);
  }

  public clear(): void {
    this.replay.clear();
    this.subscribers.clear();
  }
}
