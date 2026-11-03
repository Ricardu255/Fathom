import type {
  AgentMessage,
  ApprovalRequestedData,
  ApprovalResolvedData,
  AttachmentContextData,
  FileChange,
  FileChangedData,
  HarnessEvent,
  MemoryRecalledData,
  MessageCompletedData,
  PlanCreatedData,
  RunFailedData,
  SubAgentMessageData,
  SubAgentQueuedData,
  SubAgentStartedData,
  SubAgentTerminalData,
  SubAgentTextDeltaData,
  SubAgentToolFinishedData,
  SubAgentToolStartedData,
  SubAgentView,
  TodoItem,
  TodosUpdatedData,
  ToolCompletedData,
  ToolFailedData,
  ToolRunView,
  ToolStartedData,
  UsageData,
  UserInputRequestedData,
} from "@harness/core";
import { HarnessEventType } from "@harness/core/events";
import { isToolResultOnlyMessage } from "@harness/core/messages";
import { create } from "zustand";
import type { QueuedInput, SessionSnapshot } from "../api/types";

export type ToolRun = ToolRunView;

export type SubAgentState = SubAgentView & { streamingText: string };

export interface ChatState {
  addQueued: (item: QueuedInput) => void;
  approvals: Record<string, ApprovalRequestedData>;
  attachmentContext: AttachmentContextData | null;
  appendDelta: (text: string, seq: number) => void;
  applyEvent: (event: HarnessEvent) => void;
  compactionCount: number;
  dismissError: () => void;
  error: string | null;
  fileChanges: FileChange[];
  hydrated: boolean;
  hydrate: (sessionId: string, snapshot: SessionSnapshot) => void;
  isCompacting: boolean;
  isRunning: boolean;
  lastSeq: number;
  lastUsage: UsageData | null;
  memoryRecall: MemoryRecalledData | null;
  messages: AgentMessage[];
  plan: PlanCreatedData | null;
  queued: QueuedInput[];
  reasoningText: string;
  removeQueuedLocal: (id: string) => void;
  reset: () => void;
  retryNotice: string | null;
  runId: string | null;
  sessionId: string | null;
  setError: (message: string | null) => void;
  setQueued: (items: QueuedInput[]) => void;
  streamingText: string;
  subAgents: Record<string, SubAgentState>;
  todos: TodoItem[];
  tools: ToolRun[];
  userInputs: Record<string, UserInputRequestedData>;
}

const initialState = {
  approvals: {} as Record<string, ApprovalRequestedData>,
  attachmentContext: null as AttachmentContextData | null,
  compactionCount: 0,
  error: null,
  fileChanges: [] as FileChange[],
  hydrated: false,
  isCompacting: false,
  isRunning: false,
  lastSeq: 0,
  lastUsage: null as UsageData | null,
  memoryRecall: null as MemoryRecalledData | null,
  messages: [] as AgentMessage[],
  plan: null as PlanCreatedData | null,
  queued: [] as QueuedInput[],
  reasoningText: "",
  retryNotice: null,
  runId: null,
  sessionId: null,
  streamingText: "",
  subAgents: {} as Record<string, SubAgentState>,
  todos: [] as TodoItem[],
  tools: [] as ToolRun[],
  userInputs: {} as Record<string, UserInputRequestedData>,
};

function ensureSubAgent(agents: Record<string, SubAgentState>, executionId: string): SubAgentState {
  return (
    agents[executionId] ?? {
      agentType: "worker",
      dependsOn: [],
      errorCode: null,
      executionId,
      messages: [],
      name: executionId,
      parentExecutionId: null,
      resultSummary: null,
      status: "running",
      streamingText: "",
      task: "",
      tools: [],
    }
  );
}

export const useChatStore = create<ChatState>((set, get) => ({
  ...initialState,

  addQueued: (item) => {
    if (get().queued.some((queued) => queued.id === item.id)) return;
    set((state) => ({ queued: [...state.queued, item] }));
  },

  appendDelta: (text, seq) => {
    if (!text) {
      set((state) => ({ lastSeq: Math.max(state.lastSeq, seq) }));
      return;
    }
    set((state) => ({
      lastSeq: Math.max(state.lastSeq, seq),
      streamingText: state.streamingText + text,
    }));
  },

  applyEvent: (event) => {
    const state = get();
    if (event.seq <= state.lastSeq) return;
    const base: Partial<ChatState> = { lastSeq: event.seq };

    switch (event.type) {
      case HarnessEventType.RUN_STARTED:
        set({
          ...base,
          approvals: {},
          error: null,
          isCompacting: false,
          isRunning: true,
          plan: null,
          reasoningText: "",
          retryNotice: null,
          runId: event.runId,
          streamingText: "",
          todos: [],
          tools: [],
        });
        break;
      case HarnessEventType.REASONING_DELTA:
        set({
          ...base,
          reasoningText: state.reasoningText + (event.data as { text: string }).text,
        });
        break;
      case HarnessEventType.TEXT_DELTA:
        set({
          ...base,
          streamingText: state.streamingText + (event.data as { text: string }).text,
        });
        break;
      case HarnessEventType.MESSAGE_COMPLETED: {
        const data = event.data as MessageCompletedData;
        const message = data.message as AgentMessage | undefined;
        const displayed =
          message !== undefined && data.hidden !== true && !isToolResultOnlyMessage(message)
            ? message
            : null;
        set({
          ...base,
          messages: displayed === null ? state.messages : [...state.messages, displayed],
          queued:
            data.queuedInputId === undefined
              ? state.queued
              : state.queued.filter((item) => item.id !== data.queuedInputId),
          reasoningText: "",
          streamingText: "",
        });
        break;
      }
      case HarnessEventType.TOOL_STARTED: {
        const data = event.data as ToolStartedData;
        if (state.tools.some((tool) => tool.id === data.toolCallId)) break;
        set({
          ...base,
          tools: [
            ...state.tools,
            {
              id: data.toolCallId,
              input: data.input,
              name: data.toolName,
              status: "running",
            },
          ],
        });
        break;
      }
      case HarnessEventType.TOOL_COMPLETED: {
        const data = event.data as ToolCompletedData;
        const truncated = data.result.length > 16_000;
        set({
          ...base,
          tools: state.tools.map((tool) =>
            tool.id === data.toolCallId
              ? {
                  ...tool,
                  result: truncated ? data.result.slice(0, 16_000) : data.result,
                  resultTruncated: truncated,
                  status: "completed",
                }
              : tool,
          ),
        });
        break;
      }
      case HarnessEventType.TOOL_FAILED: {
        const data = event.data as ToolFailedData;
        set({
          ...base,
          tools: state.tools.map((tool) =>
            tool.id === data.toolCallId ? { ...tool, error: data.error, status: "failed" } : tool,
          ),
        });
        break;
      }
      case HarnessEventType.APPROVAL_REQUESTED: {
        const data = event.data as ApprovalRequestedData;
        set({
          ...base,
          approvals: { ...state.approvals, [data.approvalId]: data },
          isRunning: true,
        });
        break;
      }
      case HarnessEventType.APPROVAL_RESOLVED: {
        const data = event.data as ApprovalResolvedData;
        const approvals = { ...state.approvals };
        delete approvals[data.approvalId];
        set({ ...base, approvals });
        break;
      }
      case HarnessEventType.INPUT_REQUESTED: {
        const data = event.data as UserInputRequestedData;
        set({
          ...base,
          isRunning: true,
          userInputs: { ...state.userInputs, [data.inputId]: data },
        });
        break;
      }
      case HarnessEventType.INPUT_RESOLVED:
      case HarnessEventType.INPUT_EXPIRED: {
        const data = event.data as { inputId?: unknown } | null;
        if (typeof data?.inputId !== "string") break;
        const userInputs = { ...state.userInputs };
        delete userInputs[data.inputId];
        set({ ...base, userInputs });
        break;
      }
      case HarnessEventType.CONTEXT_COMPACTION_STARTED:
        set({ ...base, isCompacting: true });
        break;
      case HarnessEventType.CONTEXT_COMPACTED: {
        const data = event.data as { summary?: unknown } | null;
        const compacted = typeof data?.summary === "string" && data.summary.trim() !== "";
        set({
          ...base,
          compactionCount: state.compactionCount + (compacted ? 1 : 0),
          isCompacting: false,
        });
        break;
      }
      case HarnessEventType.FILE_CHANGED: {
        const data = event.data as FileChangedData;
        const change: FileChange = {
          after: data.after,
          before: data.before,
          diff: data.diff,
          path: data.path,
        };
        const exists = state.fileChanges.some(
          (item) => item.path === change.path && item.diff === change.diff,
        );
        set({
          ...base,
          fileChanges: exists ? state.fileChanges : [...state.fileChanges, change].slice(-100),
        });
        break;
      }
      case HarnessEventType.TODOS_UPDATED:
        set({ ...base, todos: (event.data as TodosUpdatedData).todos as TodoItem[] });
        break;
      case HarnessEventType.SUBAGENT_QUEUED: {
        const data = event.data as SubAgentQueuedData;
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              agentType: data.agentType,
              dependsOn: [...data.dependsOn],
              errorCode: null,
              executionId: data.executionId,
              messages: [],
              name: data.name,
              parentExecutionId: data.parentExecutionId,
              resultSummary: null,
              status: "pending",
              streamingText: "",
              task: data.task,
              tools: [],
            },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_STARTED: {
        const data = event.data as SubAgentStartedData;
        const existing = state.subAgents[data.executionId];
        const dependsOn = data.dependsOn === undefined ? [] : [...data.dependsOn];
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              ...(existing ?? {
                agentType: data.agentType,
                errorCode: null,
                executionId: data.executionId,
                messages: [],
                name: data.name,
                parentExecutionId: data.parentExecutionId,
                resultSummary: null,
                streamingText: "",
                task: data.task,
                tools: [],
              }),
              agentType: data.agentType,
              dependsOn,
              name: data.name,
              status: "running",
              task: data.task,
            },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_TEXT_DELTA: {
        const data = event.data as SubAgentTextDeltaData;
        const agent = state.subAgents[data.executionId];
        if (agent === undefined) break;
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: { ...agent, streamingText: agent.streamingText + data.text },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_MESSAGE_COMPLETED: {
        const data = event.data as SubAgentMessageData;
        const agent = ensureSubAgent(state.subAgents, data.executionId);
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              ...agent,
              messages: [...agent.messages, data.message as AgentMessage],
              streamingText: "",
            },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_TOOL_STARTED: {
        const data = event.data as SubAgentToolStartedData;
        const agent = ensureSubAgent(state.subAgents, data.executionId);
        if (agent.tools.some((tool) => tool.toolCallId === data.toolCallId)) break;
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              ...agent,
              tools: [
                ...agent.tools,
                {
                  input: data.input,
                  status: "running",
                  toolCallId: data.toolCallId,
                  toolName: data.toolName,
                },
              ],
            },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_TOOL_COMPLETED:
      case HarnessEventType.SUBAGENT_TOOL_FAILED: {
        const data = event.data as SubAgentToolFinishedData;
        const agent = state.subAgents[data.executionId];
        if (agent === undefined) break;
        const failed = event.type === HarnessEventType.SUBAGENT_TOOL_FAILED;
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              ...agent,
              tools: agent.tools.map((tool) =>
                tool.toolCallId === data.toolCallId
                  ? {
                      ...tool,
                      ...(failed
                        ? { error: data.error ?? "工具执行失败", status: "failed" as const }
                        : { result: data.result ?? "", status: "completed" as const }),
                    }
                  : tool,
              ),
            },
          },
        });
        break;
      }
      case HarnessEventType.SUBAGENT_COMPLETED:
      case HarnessEventType.SUBAGENT_FAILED:
      case HarnessEventType.SUBAGENT_ABORTED: {
        const data = event.data as SubAgentTerminalData;
        const agent = ensureSubAgent(state.subAgents, data.executionId);
        const status: SubAgentView["status"] =
          event.type === HarnessEventType.SUBAGENT_COMPLETED
            ? "completed"
            : event.type === HarnessEventType.SUBAGENT_ABORTED
              ? "aborted"
              : "failed";
        set({
          ...base,
          subAgents: {
            ...state.subAgents,
            [data.executionId]: {
              ...agent,
              errorCode: data.errorCode ?? agent.errorCode,
              resultSummary: data.resultSummary ?? agent.resultSummary,
              status,
              streamingText: "",
              ...(data.usage === undefined ? {} : { usage: data.usage }),
            },
          },
        });
        break;
      }
      case HarnessEventType.MODEL_RETRY: {
        const data = event.data as {
          attempt: number;
          delayMs?: number;
          maxAttempts?: number;
          message: string;
        };
        const total = data.maxAttempts === undefined ? "" : `/${data.maxAttempts}`;
        const delay =
          data.delayMs === undefined
            ? ""
            : ` · ${Math.max(1, Math.round(data.delayMs / 1000))} 秒后`;
        set({
          ...base,
          retryNotice: `第 ${data.attempt}${total} 次自动重试${delay}：${data.message}`,
        });
        break;
      }
      case HarnessEventType.USAGE:
        set({ ...base, lastUsage: event.data as UsageData });
        break;
      case HarnessEventType.PLAN_CREATED: {
        set({ ...base, plan: event.data as PlanCreatedData });
        break;
      }
      case HarnessEventType.ATTACHMENT_CONTEXT: {
        const data = event.data as AttachmentContextData;
        set({
          ...base,
          attachmentContext: data.attachments.length === 0 ? null : data,
        });
        break;
      }
      case HarnessEventType.MEMORY_RECALLED: {
        const data = event.data as MemoryRecalledData;
        set({ ...base, memoryRecall: data.titles.length === 0 ? null : data });
        break;
      }
      case HarnessEventType.RUN_COMPLETED:
      case HarnessEventType.RUN_ABORTED:
        set({
          ...base,
          approvals: {},
          isCompacting: false,
          isRunning: false,
          queued: [],
          runId: null,
          streamingText: "",
        });
        break;
      case HarnessEventType.RUN_FAILED:
        set({
          ...base,
          approvals: {},
          error: (event.data as RunFailedData).message,
          isCompacting: false,
          isRunning: false,
          queued: [],
          runId: null,
          streamingText: "",
        });
        break;
      default:
        break;
    }
  },

  dismissError: () => set({ error: null }),

  hydrate: (sessionId, snapshot) => {
    const state = get();
    if (state.sessionId === sessionId && state.hydrated) return;
    set({
      ...initialState,
      approvals: Object.fromEntries(
        snapshot.approvals.map((approval) => [approval.approvalId, approval]),
      ),
      attachmentContext: snapshot.attachments,
      compactionCount: snapshot.compactionCount,
      fileChanges: snapshot.fileChanges,
      hydrated: true,
      isRunning: snapshot.isRunning,
      lastSeq: snapshot.lastSeq,
      lastUsage: snapshot.lastUsage,
      memoryRecall: snapshot.memoryRecall,
      messages: snapshot.messages.filter((message) => !isToolResultOnlyMessage(message)),
      plan: snapshot.plan,
      queued: snapshot.queued,
      runId: snapshot.runId,
      sessionId,
      userInputs: Object.fromEntries(
        (snapshot.userInputs ?? []).map((input) => [input.inputId, input]),
      ),
      subAgents: Object.fromEntries(
        (snapshot.subAgents ?? []).map((agent) => [
          agent.executionId,
          { ...agent, streamingText: "" },
        ]),
      ),
      todos: snapshot.todos,
      tools: snapshot.tools ?? [],
    });
  },

  removeQueuedLocal: (id) =>
    set((state) => ({ queued: state.queued.filter((item) => item.id !== id) })),

  reset: () => set({ ...initialState }),

  setError: (message) => set({ error: message }),

  setQueued: (items) => set({ queued: items }),
}));
