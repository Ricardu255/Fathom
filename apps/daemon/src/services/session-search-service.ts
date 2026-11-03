import {
  type AgentMessage,
  type HarnessEvent,
  HarnessEventType,
  isToolResultOnlyMessage,
  messageText,
} from "@harness/core";
import type { HarnessDatabase, SessionMessageHit } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";

/** 从 JSONL 事实源派生 SQLite FTS5 消息索引，索引可随时重建。 */
export class SessionSearchService {
  public constructor(
    private readonly database: HarnessDatabase,
    private readonly events: SessionEventStore,
  ) {}

  public async initialize(): Promise<void> {
    if (this.database.sessionMessageCount() > 0) return;
    for (const session of this.database.listSessions(true)) {
      await this.reindexSession(session.id);
    }
  }

  public async reindexSession(sessionId: string): Promise<void> {
    this.database.clearSessionMessages(sessionId);
    const events = await this.events.read(sessionId, 0);
    for (const event of events) {
      const message = visibleMessage(event);
      if (message === null) continue;
      this.database.indexSessionMessage({
        content: message.text,
        role: message.role,
        seq: event.seq,
        sessionId,
        timestamp: event.timestamp,
      });
    }
  }

  public search(query: string, limit = 30): SessionMessageHit[] {
    return this.database.searchSessionMessages(query, limit);
  }
}

function visibleMessage(event: HarnessEvent): { role: "assistant" | "user"; text: string } | null {
  if (event.type !== HarnessEventType.MESSAGE_COMPLETED) return null;
  const data = asRecord(event.data);
  if (data.hidden === true) return null;
  const message = data.message;
  if (!isAgentMessage(message) || isToolResultOnlyMessage(message)) return null;
  const text = messageText(message).trim();
  return text === "" ? null : { role: message.role, text };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { content?: unknown; role?: unknown };
  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    Array.isArray(candidate.content)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
