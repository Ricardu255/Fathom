import { type HarnessEvent, HarnessEventType, messageText } from "@harness/core";

const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 400;

/** 从 JSONL 重建一次可安全续跑的说明；不重放工具副作用。 */
export function buildResumePrompt(events: readonly HarnessEvent[]): string {
  const lastStart = [...events]
    .reverse()
    .find((event) => event.type === HarnessEventType.RUN_STARTED);
  const runId = lastStart?.runId ?? null;
  const scoped = runId === null ? events : events.filter((event) => event.runId === runId);
  const userGoal = lastUserText(scoped);
  const assistantTail = lastAssistantText(scoped);
  const tools = completedTools(scoped);
  const lines = [
    "继续完成上次被中断的任务。先读取相关文件确认当前状态，不要重复已经成功的写操作或命令。",
    ...(userGoal === "" ? [] : ["", `上次目标：${userGoal}`]),
    ...(assistantTail === "" ? [] : ["", `上次输出摘要：${assistantTail}`]),
    ...(tools.length === 0 ? [] : ["", "已成功执行的工具：", ...tools.map((tool) => `- ${tool}`)]),
  ];
  return lines.join("\n");
}

function lastUserText(events: readonly HarnessEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    const data = asRecord(event.data);
    if (data.hidden === true) continue;
    const message = data.message;
    if (!isMessage(message) || message.role !== "user") continue;
    const text = messageText(message).trim();
    if (text !== "") return clamp(text, 1_000);
  }
  return "";
}

function lastAssistantText(events: readonly HarnessEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    const data = asRecord(event.data);
    if (data.hidden === true) continue;
    const message = data.message;
    if (!isMessage(message) || message.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (text !== "") return clamp(text, 2_000);
  }
  return "";
}

function completedTools(events: readonly HarnessEvent[]): string[] {
  const tools: string[] = [];
  for (const event of events) {
    if (event.type !== HarnessEventType.TOOL_COMPLETED) continue;
    const data = asRecord(event.data);
    if (typeof data.toolName !== "string") continue;
    const result = typeof data.result === "string" ? clamp(data.result, MAX_ITEM_CHARS) : "";
    tools.push(`${data.toolName}${result === "" ? "" : `：${result}`}`);
    if (tools.length >= MAX_ITEMS) break;
  }
  return tools;
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isMessage(value: unknown): value is Parameters<typeof messageText>[0] {
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
