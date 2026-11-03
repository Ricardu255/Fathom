export type SessionId = string;
export type RunId = string;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const HarnessEventType = {
  RUN_STARTED: "run.started",
  MESSAGE_COMPLETED: "message.completed",
  TEXT_DELTA: "text.delta",
  REASONING_DELTA: "reasoning.delta",
  TOOL_STARTED: "tool.started",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  INPUT_REQUESTED: "input.requested",
  INPUT_RESOLVED: "input.resolved",
  INPUT_EXPIRED: "input.expired",
  CONTEXT_COMPACTION_STARTED: "context.compaction_started",
  CONTEXT_COMPACTED: "context.compacted",
  CONTEXT_CHECKPOINT_RESTORED: "context.checkpoint_restored",
  REQUEST_SNAPSHOT: "request.snapshot",
  FILE_CHANGED: "file.changed",
  TODOS_UPDATED: "todos.updated",
  MODEL_RETRY: "model.retry",
  SUBAGENT_QUEUED: "subagent.queued",
  SUBAGENT_STARTED: "subagent.started",
  SUBAGENT_TEXT_DELTA: "subagent.text.delta",
  SUBAGENT_MESSAGE_COMPLETED: "subagent.message.completed",
  SUBAGENT_TOOL_STARTED: "subagent.tool.started",
  SUBAGENT_TOOL_COMPLETED: "subagent.tool.completed",
  SUBAGENT_TOOL_FAILED: "subagent.tool.failed",
  SUBAGENT_COMPLETED: "subagent.completed",
  SUBAGENT_FAILED: "subagent.failed",
  SUBAGENT_ABORTED: "subagent.aborted",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",
  RUN_ABORTED: "run.aborted",
  USAGE: "usage",
  MEMORY_RECALLED: "memory.recalled",
  ATTACHMENT_CONTEXT: "attachment.context",
  PLAN_CREATED: "plan.created",
} as const;

export type HarnessEventType = (typeof HarnessEventType)[keyof typeof HarnessEventType];

export interface MemoryRecalledData {
  memoryIds: string[];
  titles: string[];
}

export interface PlanCreatedData {
  planId: string;
  text: string;
}

export interface AttachmentContextData {
  attachments: {
    charCount: number;
    fileName: string;
    id: string;
    kind: string;
  }[];
}

export interface HarnessEvent<T = unknown> {
  data: T;
  id: string;
  runId: RunId | null;
  seq: number;
  sessionId: SessionId;
  timestamp: number;
  type: HarnessEventType;
}

export interface RunStartedData {
  model: string;
  tools: readonly string[];
}

export interface TextDeltaData {
  text: string;
}

export interface MessageCompletedData {
  hidden?: boolean;
  message: unknown;
  /** 该消息来自运行中排队的输入；前端据此移除排队项。 */
  queuedInputId?: string;
}

export interface ToolStartedData {
  input: unknown;
  toolCallId: string;
  toolName: string;
}

export interface ToolCompletedData {
  result: string;
  toolCallId: string;
  toolName: string;
}

export interface ToolFailedData {
  error: string;
  toolCallId: string;
  toolName: string;
}

export interface UserInputOption {
  description?: string;
  id: string;
  label: string;
}

export interface UserInputQuestion {
  allowCustomInput: boolean;
  body: string;
  id: string;
  multiSelect: boolean;
  options: UserInputOption[];
  title: string;
}

export interface UserInputRequestedData {
  executionId?: string;
  inputId: string;
  questions: UserInputQuestion[];
  timeoutMs?: number;
}

export interface UserInputAnswer {
  questionId: string;
  selectedOption?: string;
  selectedOptions?: string[];
  value: string;
}

export interface UserInputResolvedData {
  answers: UserInputAnswer[];
  executionId?: string;
  inputId: string;
}

export interface UserInputExpiredData {
  executionId?: string;
  inputId: string;
  reason: "aborted" | "timeout";
}

export interface ApprovalRequestedData {
  approvalId: string;
  consequence?: string;
  executionId?: string;
  input: unknown;
  prefixRule?: string;
  risk?: "high" | "normal";
  summary: string;
  target?: string;
  toolCallId: string;
  toolName: string;
}

export type ApprovalDecision = "approved" | "denied";

export interface ApprovalResolvedData {
  approvalId: string;
  decision: ApprovalDecision;
  executionId?: string;
}

export interface RunCompletedData {
  steps: number;
}

export interface RunFailedData {
  code?: string;
  message: string;
}

/** 已持久化的工具运行投影；用于刷新后恢复工具卡。 */
export interface ToolRunView {
  error?: string;
  id: string;
  input: unknown;
  name: string;
  result?: string;
  resultTruncated?: boolean;
  status: "completed" | "failed" | "running";
}

export interface UsageData extends Usage {
  model: string;
}

export interface CompactionStartedData {
  estimatedTokens: number;
  limit: number;
}

export interface ContextCheckpoint {
  blockers: string[];
  completed: string[];
  constraints: string[];
  decisions: string[];
  goal: string;
  nextSteps: string[];
  pending: string[];
}

export interface ContextCompactedData {
  afterTokens: number;
  beforeTokens: number;
  replacedMessages: number;
  /** 压缩后仍保留的最近消息起始时间；用于恢复时重建“摘要 + 近期消息”。 */
  retainedFrom?: number;
  summary: string;
  /** 结构化工作状态；旧事件可能没有。 */
  checkpoint?: ContextCheckpoint;
  /** 稳定版本 ID；旧事件可能没有。 */
  checkpointId?: string;
  /** 上一版检查点 ID；第一版为 null。 */
  previousCheckpointId?: string | null;
  /** 本检查点覆盖的事件序号范围（含边界）。 */
  coveredFromSeq?: number;
  coveredToSeq?: number;
  /** 自动压缩还是用户手动触发。 */
  trigger?: "auto" | "manual";
}

export interface CheckpointRestoredData {
  checkpoint: ContextCheckpoint;
  checkpointId: string;
}

export interface RequestSnapshotTool {
  description: string;
  inputSchema: unknown;
  name: string;
}

export interface RequestSnapshotData {
  estimatedInputTokens: number;
  messages: unknown[];
  model: string;
  requestIndex: number;
  runId: string | null;
  systemPrompt: string;
  tools: RequestSnapshotTool[];
  truncated: boolean;
}

export const TodoStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  BLOCKED: "blocked",
} as const;

export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

export interface TodoItem {
  content: string;
  id: string;
  status: TodoStatus;
}

export interface TodosUpdatedData {
  todos: readonly TodoItem[];
}

export interface FileChange {
  after: string | null;
  before: string | null;
  diff: string;
  path: string;
}

export interface FileChangedData extends FileChange {
  toolCallId: string;
  toolName: string;
}

export interface ModelRetryData {
  attempt: number;
  code: string;
  /** 距离下一次尝试的等待时间；旧事件可能没有。 */
  delayMs?: number;
  /** 本次重试策略允许的最大尝试次数；旧事件可能没有。 */
  maxAttempts?: number;
  message: string;
}

export const SubAgentStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted",
} as const;

export type SubAgentStatus = (typeof SubAgentStatus)[keyof typeof SubAgentStatus];

export interface SubAgentQueuedData {
  agentType: string;
  dependsOn: readonly string[];
  executionId: string;
  modelId: string;
  name: string;
  parentExecutionId: string | null;
  task: string;
}

export interface SubAgentStartedData {
  agentType: string;
  dependsOn?: readonly string[];
  executionId: string;
  modelId: string;
  name: string;
  parentExecutionId: string | null;
  task: string;
}

export interface SubAgentTextDeltaData {
  executionId: string;
  text: string;
}

export interface SubAgentMessageData {
  executionId: string;
  message: unknown;
  parentExecutionId: string | null;
}

export interface SubAgentToolStartedData {
  executionId: string;
  input: unknown;
  toolCallId: string;
  toolName: string;
}

export interface SubAgentToolFinishedData {
  executionId: string;
  error?: string;
  result?: string;
  toolCallId: string;
  toolName: string;
}

export interface SubAgentTerminalData {
  errorCode?: string;
  executionId: string;
  parentExecutionId: string | null;
  resultSummary?: string;
  usage?: Usage;
}

/** 只实时广播、不写入 JSONL 的事件。 */
export const TRANSIENT_EVENT_TYPES: ReadonlySet<HarnessEventType> = new Set([
  HarnessEventType.TEXT_DELTA,
  HarnessEventType.REASONING_DELTA,
  HarnessEventType.SUBAGENT_TEXT_DELTA,
]);

export function isTransientEventType(type: HarnessEventType): boolean {
  return TRANSIENT_EVENT_TYPES.has(type);
}
