import {
  type AgentMessage,
  type CheckpointRestoredData,
  type ContextCheckpoint,
  type ContextCompactedData,
  type HarnessEvent,
  HarnessEventType,
  isToolResultOnlyMessage,
  messageText,
  type TodoItem,
} from "@harness/core";

export interface StoredCheckpoint {
  checkpoint: ContextCheckpoint;
  checkpointId: string;
  coveredFromSeq: number;
  coveredToSeq: number;
  createdAt: number;
  previousCheckpointId: string | null;
  seq: number;
  summary: string;
  trigger: "auto" | "manual";
}

export type CheckpointField = keyof ContextCheckpoint;

export interface CheckpointDiffEntry {
  added: string[];
  after: string | string[];
  before: string | string[];
  field: CheckpointField;
  removed: string[];
}

const CHECKPOINT_FIELDS: readonly CheckpointField[] = [
  "goal",
  "constraints",
  "decisions",
  "completed",
  "pending",
  "blockers",
  "nextSteps",
];

const LABEL_TO_FIELD = new Map<string, CheckpointField>([
  ["目标", "goal"],
  ["用户目标", "goal"],
  ["goal", "goal"],
  ["objective", "goal"],
  ["约束", "constraints"],
  ["限制", "constraints"],
  ["constraints", "constraints"],
  ["constraint", "constraints"],
  ["决策", "decisions"],
  ["决定", "decisions"],
  ["decisions", "decisions"],
  ["decision", "decisions"],
  ["已完成", "completed"],
  ["完成事项", "completed"],
  ["已完成事项", "completed"],
  ["completed", "completed"],
  ["done", "completed"],
  ["待完成", "pending"],
  ["未完成", "pending"],
  ["待办", "pending"],
  ["pending", "pending"],
  ["remaining", "pending"],
  ["阻塞", "blockers"],
  ["阻塞项", "blockers"],
  ["风险", "blockers"],
  ["blockers", "blockers"],
  ["blocker", "blockers"],
  ["risks", "blockers"],
  ["下一步", "nextSteps"],
  ["后续步骤", "nextSteps"],
  ["next steps", "nextSteps"],
  ["next step", "nextSteps"],
  ["follow-up", "nextSteps"],
]);

const MAX_GOAL_CHARS = 2_000;
const MAX_ITEM_CHARS = 500;
const MAX_ITEMS_PER_FIELD = 20;

/**
 * 从事件投影与 pi 压缩摘要中派生结构化工作状态。
 * 事件提供确定性的事实（目标、Todos、未决审批、工具失败），摘要只在包含分节标题时补充。
 */
export function buildContextCheckpoint(
  events: readonly HarnessEvent[],
  summary: string,
): ContextCheckpoint {
  const todos = latestTodos(events);
  const sections = parseCheckpointSections(summary);
  const approvalBlockers = pendingApprovalSummaries(events).map((item) => `等待审批：${item}`);
  const inputBlockers = pendingUserInputTitles(events).map((item) => `等待用户回答：${item}`);
  const toolBlockers = recentToolFailures(events).map(
    (item) => `工具 ${item.toolName} 失败：${item.error}`,
  );

  const completed = limitItems([
    ...todosByStatus(todos, "completed"),
    ...(sections.completed ?? []),
  ]);
  const pending = limitItems([
    ...todosByStatus(todos, "pending"),
    ...todosByStatus(todos, "in_progress"),
    ...(sections.pending ?? []),
  ]);
  const blockers = limitItems([
    ...todosByStatus(todos, "blocked"),
    ...approvalBlockers,
    ...inputBlockers,
    ...toolBlockers,
    ...(sections.blockers ?? []),
  ]);
  const nextSteps = limitItems([
    ...todosByStatus(todos, "in_progress"),
    ...todosByStatus(todos, "pending"),
    ...(sections.nextSteps ?? []),
  ]);

  return {
    blockers,
    completed,
    constraints: limitItems(sections.constraints ?? []),
    decisions: limitItems(sections.decisions ?? []),
    goal: clampGoal(latestGoal(events) || sections.goal?.[0] || ""),
    nextSteps,
    pending,
  };
}

/** 从 JSONL 事件中收集所有带稳定 ID 的检查点，按时间顺序返回。 */
export function collectCheckpoints(events: readonly HarnessEvent[]): StoredCheckpoint[] {
  const checkpoints: StoredCheckpoint[] = [];
  for (const event of events) {
    if (event.type !== HarnessEventType.CONTEXT_COMPACTED) continue;
    const data = asRecord(event.data) as Partial<ContextCompactedData>;
    if (typeof data.checkpointId !== "string" || !isContextCheckpoint(data.checkpoint)) continue;
    checkpoints.push({
      checkpoint: data.checkpoint,
      checkpointId: data.checkpointId,
      coveredFromSeq: typeof data.coveredFromSeq === "number" ? data.coveredFromSeq : 0,
      coveredToSeq: typeof data.coveredToSeq === "number" ? data.coveredToSeq : event.seq,
      createdAt: event.timestamp,
      previousCheckpointId:
        typeof data.previousCheckpointId === "string" ? data.previousCheckpointId : null,
      seq: event.seq,
      summary: typeof data.summary === "string" ? data.summary : "",
      trigger: data.trigger === "manual" ? "manual" : "auto",
    });
  }
  return checkpoints;
}

/** 找到最后一次恢复事件；如果之后已经启动过新 Run，视为已消费。 */
export function latestUnconsumedRestore(
  events: readonly HarnessEvent[],
): CheckpointRestoredData | null {
  let restored: CheckpointRestoredData | null = null;
  for (const event of events) {
    if (event.type === HarnessEventType.RUN_STARTED) {
      restored = null;
    } else if (event.type === HarnessEventType.CONTEXT_CHECKPOINT_RESTORED) {
      const data = asRecord(event.data);
      if (typeof data.checkpointId === "string" && isContextCheckpoint(data.checkpoint)) {
        restored = { checkpoint: data.checkpoint, checkpointId: data.checkpointId };
      }
    }
  }
  return restored;
}

/** 字段级对比；只返回发生变化的字段。 */
export function compareCheckpoints(
  base: ContextCheckpoint,
  target: ContextCheckpoint,
): CheckpointDiffEntry[] {
  const diffs: CheckpointDiffEntry[] = [];
  for (const field of CHECKPOINT_FIELDS) {
    if (field === "goal") {
      if (base.goal !== target.goal) {
        diffs.push({
          added: target.goal === "" ? [] : [target.goal],
          after: target.goal,
          before: base.goal,
          field,
          removed: base.goal === "" ? [] : [base.goal],
        });
      }
      continue;
    }
    const before = base[field];
    const after = target[field];
    const added = after.filter((item) => !before.includes(item));
    const removed = before.filter((item) => !after.includes(item));
    if (added.length > 0 || removed.length > 0) {
      diffs.push({ added, after, before, field, removed });
    }
  }
  return diffs;
}

/** 恢复时注入下一次 Run 的隐藏前缀。 */
export function formatCheckpointForPrompt(checkpoint: ContextCheckpoint): string {
  const lines = ["【恢复的上下文检查点】"];
  const scalar: Array<[string, string]> = [["目标", checkpoint.goal]];
  const lists: Array<[string, string[]]> = [
    ["约束", checkpoint.constraints],
    ["已决定", checkpoint.decisions],
    ["已完成", checkpoint.completed],
    ["待完成", checkpoint.pending],
    ["阻塞", checkpoint.blockers],
    ["下一步", checkpoint.nextSteps],
  ];
  for (const [label, value] of scalar) {
    if (value.trim() !== "") lines.push(`${label}：${value.trim()}`);
  }
  for (const [label, values] of lists) {
    if (values.length === 0) continue;
    lines.push(`${label}：`);
    for (const value of values) lines.push(`- ${value}`);
  }
  return lines.join("\n");
}

export function parseCheckpointSections(
  summary: string,
): Partial<Record<CheckpointField, string[]>> {
  const sections: Partial<Record<CheckpointField, string[]>> = {};
  let current: CheckpointField | null = null;
  for (const rawLine of summary.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const cleaned = line
      .replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/u, "")
      .replace(/\*\*/gu, "")
      .trim();
    if (cleaned === "") continue;
    const separator = cleaned.search(/[:：]/u);
    const label = (separator >= 0 ? cleaned.slice(0, separator) : cleaned).trim().toLowerCase();
    const rest = separator >= 0 ? cleaned.slice(separator + 1).trim() : "";
    const field = LABEL_TO_FIELD.get(label);
    if (field !== undefined) {
      current = field;
      if (rest !== "") appendSection(sections, field, rest);
      continue;
    }
    if (current !== null) appendSection(sections, current, cleaned);
  }
  return sections;
}

function appendSection(
  sections: Partial<Record<CheckpointField, string[]>>,
  field: CheckpointField,
  value: string,
): void {
  const items = value
    .split(/[；;]/u)
    .map((item) => item.replace(/^[-*+]\s+/u, "").trim())
    .filter((item) => item !== "");
  if (items.length === 0) return;
  const existing = sections[field] ?? [];
  existing.push(...items);
  sections[field] = limitItems(existing);
}

function latestGoal(events: readonly HarnessEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    const data = asRecord(event.data);
    if (data.hidden === true) continue;
    const message = data.message;
    if (!isAgentMessage(message) || message.role !== "user" || isToolResultOnlyMessage(message)) {
      continue;
    }
    const text = messageText(message).trim();
    if (text !== "") return text;
  }
  return "";
}

function latestTodos(events: readonly HarnessEvent[]): TodoItem[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== HarnessEventType.TODOS_UPDATED) continue;
    const value = asRecord(event.data).todos;
    if (!Array.isArray(value)) continue;
    const todos = value.flatMap((item): TodoItem[] => {
      if (!isRecord(item)) return [];
      const status = item.status;
      if (
        typeof item.content !== "string" ||
        typeof item.id !== "string" ||
        (status !== "pending" &&
          status !== "in_progress" &&
          status !== "completed" &&
          status !== "blocked")
      ) {
        return [];
      }
      return [{ content: item.content, id: item.id, status }];
    });
    if (todos.length > 0) return todos;
  }
  return [];
}

function todosByStatus(todos: readonly TodoItem[], status: TodoItem["status"]): string[] {
  return todos.filter((todo) => todo.status === status).map((todo) => todo.content);
}

function pendingApprovalSummaries(events: readonly HarnessEvent[]): string[] {
  const pending = new Map<string, string>();
  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === HarnessEventType.APPROVAL_REQUESTED && typeof data.approvalId === "string") {
      pending.set(
        data.approvalId,
        typeof data.summary === "string" ? data.summary : data.approvalId,
      );
    } else if (
      event.type === HarnessEventType.APPROVAL_RESOLVED &&
      typeof data.approvalId === "string"
    ) {
      pending.delete(data.approvalId);
    }
  }
  return [...pending.values()];
}

function pendingUserInputTitles(events: readonly HarnessEvent[]): string[] {
  const pending = new Map<string, string>();
  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === HarnessEventType.INPUT_REQUESTED && typeof data.inputId === "string") {
      const questions = Array.isArray(data.questions) ? data.questions : [];
      const title = questions
        .flatMap((question) =>
          isRecord(question) && typeof question.title === "string" ? [question.title] : [],
        )
        .join("；");
      pending.set(data.inputId, title === "" ? data.inputId : title);
    } else if (
      (event.type === HarnessEventType.INPUT_RESOLVED ||
        event.type === HarnessEventType.INPUT_EXPIRED) &&
      typeof data.inputId === "string"
    ) {
      pending.delete(data.inputId);
    }
  }
  return [...pending.values()];
}

function recentToolFailures(
  events: readonly HarnessEvent[],
): Array<{ error: string; toolName: string }> {
  const failures: Array<{ error: string; toolName: string }> = [];
  for (let index = events.length - 1; index >= 0 && failures.length < 3; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== HarnessEventType.TOOL_FAILED) continue;
    const data = asRecord(event.data);
    if (typeof data.toolName !== "string" || typeof data.error !== "string") continue;
    failures.push({ error: data.error.slice(0, MAX_ITEM_CHARS), toolName: data.toolName });
  }
  return failures.reverse();
}

function limitItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized.slice(0, MAX_ITEM_CHARS));
    if (result.length >= MAX_ITEMS_PER_FIELD) break;
  }
  return result;
}

function clampGoal(goal: string): string {
  const trimmed = goal.trim();
  return trimmed.length > MAX_GOAL_CHARS ? `${trimmed.slice(0, MAX_GOAL_CHARS)}…` : trimmed;
}

function isContextCheckpoint(value: unknown): value is ContextCheckpoint {
  if (!isRecord(value)) return false;
  return (
    typeof value.goal === "string" &&
    isStringArray(value.constraints) &&
    isStringArray(value.decisions) &&
    isStringArray(value.completed) &&
    isStringArray(value.pending) &&
    isStringArray(value.blockers) &&
    isStringArray(value.nextSteps)
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) return false;
  return Array.isArray(value.content);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
