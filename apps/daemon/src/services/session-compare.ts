import {
  type AgentMessage,
  type FileChange,
  type HarnessEvent,
  HarnessEventType,
  messageText,
} from "@harness/core";
import { projectEvents } from "./session-projections";

export interface SessionCompareSide {
  fileChanges: FileChange[];
  messages: AgentMessage[];
}

export interface SessionCompareResult {
  base: SessionCompareSide;
  commonCutoff: number;
  commonPrefix: number;
  target: SessionCompareSide;
}

/** 比较两个 Session 的事件投影；按消息签名找出共同前缀，返回各自分叉后的内容。 */
export function compareSessionEvents(
  baseEvents: readonly HarnessEvent[],
  targetEvents: readonly HarnessEvent[],
): SessionCompareResult {
  const baseMessages = messagesOf(baseEvents);
  const targetMessages = messagesOf(targetEvents);
  let commonPrefix = 0;
  while (
    commonPrefix < baseMessages.length &&
    commonPrefix < targetMessages.length &&
    signature(baseMessages[commonPrefix]) === signature(targetMessages[commonPrefix])
  ) {
    commonPrefix += 1;
  }

  const cutoff = commonPrefix === 0 ? 0 : (baseMessages[commonPrefix - 1]?.timestamp ?? 0);
  return {
    base: {
      fileChanges: changesAfter(baseEvents, cutoff),
      messages: baseMessages.slice(commonPrefix),
    },
    commonCutoff: cutoff,
    commonPrefix,
    target: {
      fileChanges: changesAfter(targetEvents, cutoff),
      messages: targetMessages.slice(commonPrefix),
    },
  };
}

function messagesOf(events: readonly HarnessEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const event of events) {
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    if ((data as { hidden?: unknown }).hidden === true) continue;
    const message = (data as { message?: unknown }).message;
    if (!isAgentMessage(message)) continue;
    if (messageText(message) === "" && !message.content.some((block) => block.type === "image")) {
      continue;
    }
    messages.push(message);
  }
  return messages;
}

function changesAfter(events: readonly HarnessEvent[], cutoff: number): FileChange[] {
  return projectEvents(
    events.filter(
      (event) => event.timestamp > cutoff || event.type !== HarnessEventType.FILE_CHANGED,
    ),
  ).fileChanges;
}

function signature(message: AgentMessage | undefined): string {
  if (message === undefined) return "";
  return `${message.role}|${message.timestamp}|${messageText(message)}`;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as { content?: unknown; role?: unknown; timestamp?: unknown };
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.timestamp === "number" &&
    Array.isArray(message.content)
  );
}

export function buildMergeSummary(sourceTitle: string, events: readonly HarnessEvent[]): string {
  const messages = messagesOf(events);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const fileChanges = projectEvents(events).fileChanges;
  const paths = [...new Set(fileChanges.map((change) => change.path))].slice(0, 20);
  return [
    "【分支合并摘要】",
    `来源分支：${sourceTitle}`,
    lastAssistant === undefined
      ? "来源分支没有可用的 assistant 结果。"
      : `来源分支最后结果：\n${messageText(lastAssistant).slice(0, 4_000)}`,
    paths.length === 0
      ? "来源分支没有文件变更。"
      : `来源分支文件变更：\n${paths.map((path) => `- ${path}`).join("\n")}`,
    "请在新的合并分支中同时考虑当前分支与上述来源分支的目标。",
  ].join("\n\n");
}
