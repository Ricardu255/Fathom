import {
  type AgentMessage,
  type ApprovalRequestedData,
  type AttachmentContextData,
  type FileChange,
  type HarnessEvent,
  HarnessEventType,
  type MemoryRecalledData,
  type PlanCreatedData,
  type SubAgentView,
  type TodoItem,
  type ToolRunView,
  type UsageData,
  type UserInputRequestedData,
} from "@harness/core";

export interface EventProjections {
  approvals: ApprovalRequestedData[];
  attachments: AttachmentContextData | null;
  compactionCount: number;
  fileChanges: FileChange[];
  lastUsage: UsageData | null;
  memoryRecall: MemoryRecalledData | null;
  plan: PlanCreatedData | null;
  subAgents: SubAgentView[];
  todos: TodoItem[];
  tools: ToolRunView[];
  userInputs: UserInputRequestedData[];
}

/** 从已持久化事件派生 UI 状态；事件是投影的唯一来源。 */
export function projectEvents(events: readonly HarnessEvent[]): EventProjections {
  let todos: TodoItem[] = [];
  let lastUsage: UsageData | null = null;
  let memoryRecall: MemoryRecalledData | null = null;
  let plan: PlanCreatedData | null = null;
  let compactionCount = 0;
  let tools: ToolRunView[] = [];
  const fileChanges: FileChange[] = [];
  const approvals = new Map<string, ApprovalRequestedData>();
  let attachments: AttachmentContextData | null = null;
  const subAgents = new Map<string, SubAgentView>();
  const userInputs = new Map<string, UserInputRequestedData>();

  for (const event of events) {
    if (event.type === HarnessEventType.RUN_STARTED) {
      plan = null;
      todos = [];
      tools = [];
    } else if (event.type === HarnessEventType.PLAN_CREATED && isPlanCreated(event.data)) {
      plan = event.data;
    } else if (
      event.type === HarnessEventType.ATTACHMENT_CONTEXT &&
      isAttachmentContext(event.data)
    ) {
      attachments = event.data.attachments.length === 0 ? null : event.data;
    } else if (event.type === HarnessEventType.MEMORY_RECALLED && isMemoryRecall(event.data)) {
      memoryRecall = event.data;
    } else if (
      event.type === HarnessEventType.APPROVAL_REQUESTED &&
      isApprovalRequest(event.data)
    ) {
      approvals.set(event.data.approvalId, event.data);
    } else if (event.type === HarnessEventType.APPROVAL_RESOLVED && isRecord(event.data)) {
      if (typeof event.data.approvalId === "string") approvals.delete(event.data.approvalId);
    } else if (event.type === HarnessEventType.INPUT_REQUESTED && isUserInputRequest(event.data)) {
      userInputs.set(event.data.inputId, event.data);
    } else if (
      (event.type === HarnessEventType.INPUT_RESOLVED ||
        event.type === HarnessEventType.INPUT_EXPIRED) &&
      isRecord(event.data) &&
      typeof event.data.inputId === "string"
    ) {
      userInputs.delete(event.data.inputId);
    } else if (event.type === HarnessEventType.TODOS_UPDATED && isRecord(event.data)) {
      const value = event.data.todos;
      if (Array.isArray(value)) todos = value.filter(isTodoItem).map((item) => ({ ...item }));
    } else if (event.type === HarnessEventType.USAGE && isUsage(event.data)) {
      lastUsage = event.data;
    } else if (event.type === HarnessEventType.CONTEXT_COMPACTED) {
      const summary = isRecord(event.data) ? event.data.summary : undefined;
      if (typeof summary === "string" && summary.trim() !== "") compactionCount += 1;
    } else if (event.type === HarnessEventType.FILE_CHANGED && isFileChange(event.data)) {
      fileChanges.push({
        after: event.data.after,
        before: event.data.before,
        diff: event.data.diff,
        path: event.data.path,
      });
    } else if (event.type === HarnessEventType.TOOL_STARTED) {
      applyToolStarted(tools, event.data);
    } else if (event.type === HarnessEventType.TOOL_COMPLETED) {
      applyToolCompleted(tools, event.data);
    } else if (event.type === HarnessEventType.TOOL_FAILED) {
      applyToolFailed(tools, event.data);
    } else if (event.type === HarnessEventType.SUBAGENT_QUEUED) {
      applySubAgentQueued(subAgents, event.data);
    } else if (event.type === HarnessEventType.SUBAGENT_STARTED) {
      applySubAgentStarted(subAgents, event.data);
    } else if (event.type === HarnessEventType.SUBAGENT_MESSAGE_COMPLETED) {
      applySubAgentMessage(subAgents, event.data);
    } else if (event.type === HarnessEventType.SUBAGENT_TOOL_STARTED) {
      applySubAgentTool(subAgents, event.data, "started");
    } else if (event.type === HarnessEventType.SUBAGENT_TOOL_COMPLETED) {
      applySubAgentTool(subAgents, event.data, "completed");
    } else if (event.type === HarnessEventType.SUBAGENT_TOOL_FAILED) {
      applySubAgentTool(subAgents, event.data, "failed");
    } else if (
      event.type === HarnessEventType.SUBAGENT_COMPLETED ||
      event.type === HarnessEventType.SUBAGENT_FAILED ||
      event.type === HarnessEventType.SUBAGENT_ABORTED
    ) {
      applySubAgentTerminal(subAgents, event.data, event.type);
    }
  }

  return {
    approvals: [...approvals.values()].map((approval) => ({ ...approval })),
    attachments,
    compactionCount,
    fileChanges: fileChanges.slice(-50),
    lastUsage,
    memoryRecall,
    plan,
    subAgents: [...subAgents.values()],
    todos,
    tools: tools.map((tool) => ({ ...tool })),
    userInputs: [...userInputs.values()].map((input) => ({ ...input })),
  };
}

function applyToolStarted(tools: ToolRunView[], data: unknown): void {
  if (
    !isRecord(data) ||
    typeof data.toolCallId !== "string" ||
    typeof data.toolName !== "string" ||
    tools.some((tool) => tool.id === data.toolCallId)
  ) {
    return;
  }
  tools.push({
    id: data.toolCallId,
    input: data.input,
    name: data.toolName,
    status: "running",
  });
}

function applyToolCompleted(tools: ToolRunView[], data: unknown): void {
  if (!isRecord(data) || typeof data.toolCallId !== "string") return;
  const tool = tools.find((candidate) => candidate.id === data.toolCallId);
  if (tool === undefined) return;
  const result = typeof data.result === "string" ? data.result : "";
  const truncated = result.length > 16_000;
  tool.result = truncated ? result.slice(0, 16_000) : result;
  tool.resultTruncated = truncated;
  tool.status = "completed";
}

function applyToolFailed(tools: ToolRunView[], data: unknown): void {
  if (!isRecord(data) || typeof data.toolCallId !== "string") return;
  const tool = tools.find((candidate) => candidate.id === data.toolCallId);
  if (tool === undefined) return;
  tool.error = typeof data.error === "string" ? data.error : "工具执行失败";
  tool.status = "failed";
}

function applySubAgentQueued(agents: Map<string, SubAgentView>, data: unknown): void {
  if (!isRecord(data) || typeof data.executionId !== "string") return;
  agents.set(data.executionId, {
    agentType: typeof data.agentType === "string" ? data.agentType : "worker",
    dependsOn: readDependsOn(data.dependsOn),
    errorCode: null,
    executionId: data.executionId,
    messages: [],
    name: typeof data.name === "string" ? data.name : data.executionId,
    parentExecutionId: typeof data.parentExecutionId === "string" ? data.parentExecutionId : null,
    resultSummary: null,
    status: "pending",
    task: typeof data.task === "string" ? data.task : "",
    tools: [],
  });
}

function applySubAgentStarted(agents: Map<string, SubAgentView>, data: unknown): void {
  if (!isRecord(data) || typeof data.executionId !== "string") return;
  const existing = agents.get(data.executionId);
  const dependsOn = readDependsOn(data.dependsOn);
  if (existing !== undefined) {
    existing.dependsOn = dependsOn;
    existing.status = "running";
    if (typeof data.name === "string") existing.name = data.name;
    if (typeof data.agentType === "string") existing.agentType = data.agentType;
    if (typeof data.task === "string") existing.task = data.task;
    return;
  }
  agents.set(data.executionId, {
    agentType: typeof data.agentType === "string" ? data.agentType : "worker",
    dependsOn,
    errorCode: null,
    executionId: data.executionId,
    messages: [],
    name: typeof data.name === "string" ? data.name : data.executionId,
    parentExecutionId: typeof data.parentExecutionId === "string" ? data.parentExecutionId : null,
    resultSummary: null,
    status: "running",
    task: typeof data.task === "string" ? data.task : "",
    tools: [],
  });
}

function isPlanCreated(value: unknown): value is PlanCreatedData {
  return (
    isRecord(value) &&
    typeof value.planId === "string" &&
    typeof value.text === "string" &&
    value.text.trim() !== ""
  );
}

function isAttachmentContext(value: unknown): value is AttachmentContextData {
  if (!isRecord(value) || !Array.isArray(value.attachments)) return false;
  return value.attachments.every(
    (item) =>
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.fileName === "string" &&
      typeof item.kind === "string" &&
      typeof item.charCount === "number",
  );
}

function isMemoryRecall(value: unknown): value is MemoryRecalledData {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.memoryIds) &&
    value.memoryIds.every((item) => typeof item === "string") &&
    Array.isArray(value.titles) &&
    value.titles.every((item) => typeof item === "string")
  );
}

function isApprovalRequest(value: unknown): value is ApprovalRequestedData {
  if (!isRecord(value)) return false;
  return (
    typeof value.approvalId === "string" &&
    typeof value.summary === "string" &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    (value.executionId === undefined || typeof value.executionId === "string")
  );
}

function readDependsOn(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function applySubAgentMessage(agents: Map<string, SubAgentView>, data: unknown): void {
  if (!isRecord(data) || typeof data.executionId !== "string") return;
  const agent = ensureSubAgent(agents, data.executionId);
  if (isAgentMessage(data.message)) agent.messages.push(data.message);
}

function applySubAgentTool(
  agents: Map<string, SubAgentView>,
  data: unknown,
  stage: "completed" | "failed" | "started",
): void {
  if (!isRecord(data) || typeof data.executionId !== "string") return;
  if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return;
  const agent = ensureSubAgent(agents, data.executionId);
  const existing = agent.tools.find((tool) => tool.toolCallId === data.toolCallId);
  if (stage === "started") {
    if (existing === undefined) {
      agent.tools.push({
        input: data.input,
        status: "running",
        toolCallId: data.toolCallId,
        toolName: data.toolName,
      });
    }
  } else if (existing !== undefined) {
    existing.status = stage;
    if (typeof data.result === "string") existing.result = data.result;
    if (typeof data.error === "string") existing.error = data.error;
  }
}

function applySubAgentTerminal(
  agents: Map<string, SubAgentView>,
  data: unknown,
  type: string,
): void {
  if (!isRecord(data) || typeof data.executionId !== "string") return;
  const agent = ensureSubAgent(agents, data.executionId);
  agent.status =
    type === "subagent.completed"
      ? "completed"
      : type === "subagent.aborted"
        ? "aborted"
        : "failed";
  if (typeof data.resultSummary === "string") agent.resultSummary = data.resultSummary;
  if (typeof data.errorCode === "string") agent.errorCode = data.errorCode;
  if (isTokenUsage(data.usage)) agent.usage = data.usage;
}

function ensureSubAgent(agents: Map<string, SubAgentView>, executionId: string): SubAgentView {
  const existing = agents.get(executionId);
  if (existing !== undefined) return existing;
  const created: SubAgentView = {
    agentType: "worker",
    dependsOn: [],
    errorCode: null,
    executionId,
    messages: [],
    name: executionId,
    parentExecutionId: null,
    resultSummary: null,
    status: "running",
    task: "",
    tools: [],
  };
  agents.set(executionId, created);
  return created;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  return (
    (value.role === "user" || value.role === "assistant") &&
    typeof value.timestamp === "number" &&
    Array.isArray(value.content)
  );
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "completed" ||
      value.status === "blocked")
  );
}

function isTokenUsage(value: unknown): value is { inputTokens: number; outputTokens: number } {
  return (
    isRecord(value) &&
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number"
  );
}

function isUsage(value: unknown): value is UsageData {
  return (
    isRecord(value) &&
    typeof value.model === "string" &&
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number"
  );
}

function isFileChange(value: unknown): value is FileChange & {
  toolCallId: string;
  toolName: string;
} {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.diff === "string" &&
    (value.before === null || typeof value.before === "string") &&
    (value.after === null || typeof value.after === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserInputRequest(value: unknown): value is UserInputRequestedData {
  return (
    isRecord(value) &&
    typeof value.inputId === "string" &&
    Array.isArray(value.questions) &&
    value.questions.length > 0
  );
}
