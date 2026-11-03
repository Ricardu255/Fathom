import {
  type AgentMessage,
  type HarnessEvent,
  HarnessEventType,
  isToolResultOnlyMessage,
  messageText,
} from "@harness/core";

export type SessionHistoryKind = "assistant" | "tool" | "user";

export interface SessionHistoryHit {
  kind: SessionHistoryKind;
  messageIndex: number;
  seq: number;
  snippet: string;
  timestamp: number;
}

const MAX_SNIPPET_CHARS = 400;
const SNIPPET_PREFIX_CHARS = 120;
const SNIPPET_SUFFIX_CHARS = 260;

/**
 * 在当前 Session 的完整事件流里做确定性文本检索。
 * 结果只保留有界片段，并返回可见消息序号与事件 seq，避免把整段历史塞回模型。
 */
export function searchSessionHistory(
  events: readonly HarnessEvent[],
  query: string,
  limit = 10,
): SessionHistoryHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
  const hits: SessionHistoryHit[] = [];
  let messageIndex = 0;

  for (const event of events) {
    if (event.type === HarnessEventType.MESSAGE_COMPLETED) {
      const data = asRecord(event.data);
      if (data.hidden === true) continue;
      const message = data.message;
      if (!isAgentMessage(message) || isToolResultOnlyMessage(message)) continue;
      messageIndex += 1;
      const text = messageText(message);
      if (text === "" || !matchesAllTokens(text, tokens)) continue;
      hits.push({
        kind: message.role,
        messageIndex,
        seq: event.seq,
        snippet: makeSnippet(text, tokens),
        timestamp: typeof message.timestamp === "number" ? message.timestamp : event.timestamp,
      });
      continue;
    }

    if (event.type === HarnessEventType.TOOL_COMPLETED) {
      const data = asRecord(event.data);
      if (typeof data.result !== "string" || typeof data.toolName !== "string") continue;
      const text = `[工具 ${data.toolName}] ${data.result}`;
      if (!matchesAllTokens(text, tokens)) continue;
      hits.push({
        kind: "tool",
        messageIndex,
        seq: event.seq,
        snippet: makeSnippet(text, tokens),
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === HarnessEventType.TOOL_FAILED) {
      const data = asRecord(event.data);
      if (typeof data.error !== "string" || typeof data.toolName !== "string") continue;
      const text = `[工具 ${data.toolName} 失败] ${data.error}`;
      if (!matchesAllTokens(text, tokens)) continue;
      hits.push({
        kind: "tool",
        messageIndex,
        seq: event.seq,
        snippet: makeSnippet(text, tokens),
        timestamp: event.timestamp,
      });
    }
  }

  return hits.reverse().slice(0, boundedLimit);
}

export function formatSessionHistoryHits(hits: readonly SessionHistoryHit[]): string {
  if (hits.length === 0) return "没有找到匹配的历史记录。";
  const lines = hits.map(
    (hit) =>
      `- [消息 ${hit.messageIndex} / seq ${hit.seq}] ${hit.kind}（${new Date(hit.timestamp).toLocaleString()}）：${hit.snippet}`,
  );
  return `找到 ${hits.length} 条历史记录（按时间倒序）：\n${lines.join("\n")}`;
}

function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token !== "")
    .slice(0, 10);
}

function matchesAllTokens(text: string, tokens: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function makeSnippet(text: string, tokens: readonly string[]): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const lower = normalized.toLowerCase();
  const index = tokens
    .map((token) => lower.indexOf(token))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];
  if (index === undefined) return normalized.slice(0, MAX_SNIPPET_CHARS);

  const start = Math.max(0, index - SNIPPET_PREFIX_CHARS);
  const end = Math.min(normalized.length, index + SNIPPET_SUFFIX_CHARS);
  const body = normalized.slice(start, end);
  return `${start > 0 ? "…" : ""}${body}${end < normalized.length ? "…" : ""}`;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
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
