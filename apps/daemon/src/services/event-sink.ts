import {
  type AgentMessage,
  type HarnessEvent,
  HarnessEventType,
  isToolResultOnlyMessage,
  isTransientEventType,
  messageText,
} from "@harness/core";
import type { HarnessDatabase } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";
import type { SessionEventBus } from "./event-bus";

export interface EventSinkLogger {
  error(details: Record<string, unknown>, message: string): void;
}

/** JSONL 为事实源；SQLite 索引失败不影响 Run，但 JSONL 写入失败会让 Run 失败。 */
export class SessionEventSink {
  public constructor(
    private readonly database: HarnessDatabase,
    private readonly events: SessionEventStore,
    private readonly bus: SessionEventBus,
    private readonly logger: EventSinkLogger,
  ) {}

  public handle = async (event: HarnessEvent): Promise<void> => {
    if (!isTransientEventType(event.type)) {
      try {
        await this.events.append(event);
      } catch (error: unknown) {
        this.bus.publish(event);
        this.logger.error(
          { err: error, sessionId: event.sessionId, type: event.type },
          "事件写入 JSONL 失败",
        );
        throw error;
      }
      try {
        this.database.setSessionLastSeq(event.sessionId, event.seq);
        this.database.touchSession(event.sessionId, event.timestamp);
        this.indexMessage(event);
      } catch (error: unknown) {
        this.logger.error(
          { err: error, sessionId: event.sessionId, type: event.type },
          "事件索引更新失败",
        );
      }
    }
    this.bus.publish(event);
  };

  private indexMessage(event: HarnessEvent): void {
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) return;
    const data =
      typeof event.data === "object" && event.data !== null
        ? (event.data as Record<string, unknown>)
        : {};
    if (data.hidden === true) return;
    const message = data.message;
    if (!isAgentMessage(message) || isToolResultOnlyMessage(message)) return;
    const content = messageText(message).trim();
    if (content === "") return;
    this.database.indexSessionMessage({
      content,
      role: message.role,
      seq: event.seq,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
    });
  }
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { content?: unknown; role?: unknown };
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    Array.isArray(candidate.content)
  );
}
