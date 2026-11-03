import { type AgentMessage, type HarnessEvent, HarnessEventType, messageText } from "@harness/core";
import type { SessionEventStore } from "../storage/event-store";

const MAX_PREVIEW_CHARS = 16_000;
const MAX_SUBAGENT_EVENTS = 200;

export interface TraceMessage {
  role: string;
  seq: number;
  text: string;
  timestamp: number;
}

export interface TraceTool {
  endedAt: number | null;
  error: string | null;
  input: unknown;
  result: string | null;
  startedAt: number;
  status: "completed" | "failed" | "running";
  toolCallId: string;
  toolName: string;
}

export interface TraceApproval {
  approvalId: string;
  decision: "approved" | "denied" | null;
  requestedAt: number;
  resolvedAt: number | null;
  risk: "high" | "normal" | null;
  summary: string;
  toolName: string;
}

export interface TraceRequest {
  estimatedInputTokens: number;
  inputTokens: number;
  messages: unknown[];
  model: string;
  outputTokens: number;
  requestIndex: number;
  seq: number;
  systemPrompt: string;
  timestamp: number;
  tools: unknown[];
}

export interface TraceCompaction {
  afterTokens: number;
  beforeTokens: number;
  checkpointId: string | null;
  seq: number;
  summary: string;
  timestamp: number;
  trigger: "auto" | "manual" | null;
}

export interface TraceSubAgent {
  agentType: string;
  endedAt: number | null;
  errorCode: string | null;
  executionId: string;
  messages: Array<{ role: string; text: string; timestamp: number }>;
  modelId: string;
  name: string;
  parentExecutionId: string | null;
  startedAt: number;
  status: "aborted" | "completed" | "failed" | "queued" | "running";
  task: string;
  tools: TraceTool[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface TraceRun {
  approvals: TraceApproval[];
  compactions: TraceCompaction[];
  endedAt: number | null;
  messages: TraceMessage[];
  model: string;
  requests: TraceRequest[];
  runId: string;
  startedAt: number;
  status: "completed" | "failed" | "aborted" | "running";
  steps: number;
  subAgents: TraceSubAgent[];
  tools: TraceTool[];
}

export interface SessionTrace {
  runs: TraceRun[];
  sessionId: string;
}

export class TraceService {
  public constructor(private readonly events: SessionEventStore) {}

  public async trace(sessionId: string): Promise<SessionTrace> {
    const events = await this.events.read(sessionId, 0);
    return { runs: projectTrace(events), sessionId };
  }
}

export function projectTrace(events: readonly HarnessEvent[]): TraceRun[] {
  const runs = new Map<string, TraceRun>();
  const toolMaps = new Map<string, Map<string, TraceTool>>();
  const approvalMaps = new Map<string, Map<string, TraceApproval>>();
  const subAgentMaps = new Map<string, Map<string, TraceSubAgent>>();

  const runFor = (runId: string | null, firstEvent: HarnessEvent): TraceRun => {
    const key = runId ?? `orphan`;
    let run = runs.get(key);
    if (run === undefined) {
      run = {
        approvals: [],
        compactions: [],
        endedAt: null,
        messages: [],
        model: "",
        requests: [],
        runId: key,
        startedAt: firstEvent.timestamp,
        status: "running",
        steps: 0,
        subAgents: [],
        tools: [],
      };
      runs.set(key, run);
      toolMaps.set(key, new Map());
      approvalMaps.set(key, new Map());
      subAgentMaps.set(key, new Map());
    }
    return run;
  };
  const runOf = (event: HarnessEvent): TraceRun => runFor(event.runId, event);
  const toolsOf = (run: TraceRun): Map<string, TraceTool> => toolMaps.get(run.runId) ?? new Map();
  const approvalsOf = (run: TraceRun): Map<string, TraceApproval> =>
    approvalMaps.get(run.runId) ?? new Map();
  const subAgentsOf = (run: TraceRun): Map<string, TraceSubAgent> =>
    subAgentMaps.get(run.runId) ?? new Map();

  for (const event of events) {
    const data = asRecord(event.data);
    switch (event.type) {
      case HarnessEventType.RUN_STARTED: {
        const run = runOf(event);
        run.model = typeof data.model === "string" ? data.model : "";
        run.startedAt = event.timestamp;
        break;
      }
      case HarnessEventType.REQUEST_SNAPSHOT: {
        const run = runOf(event);
        run.requests.push({
          estimatedInputTokens: numberOrZero(data.estimatedInputTokens),
          inputTokens: 0,
          messages: Array.isArray(data.messages) ? data.messages : [],
          model: typeof data.model === "string" ? data.model : run.model,
          outputTokens: 0,
          requestIndex: numberOrZero(data.requestIndex),
          seq: event.seq,
          systemPrompt: typeof data.systemPrompt === "string" ? data.systemPrompt : "",
          timestamp: event.timestamp,
          tools: Array.isArray(data.tools) ? data.tools : [],
        });
        break;
      }
      case HarnessEventType.USAGE: {
        const run = runOf(event);
        const target = [...run.requests].reverse().find((request) => request.inputTokens === 0);
        const inputTokens = numberOrZero(data.inputTokens);
        const outputTokens = numberOrZero(data.outputTokens);
        if (target !== undefined) {
          target.inputTokens = inputTokens;
          target.outputTokens = outputTokens;
          if (typeof data.model === "string" && data.model !== "") target.model = data.model;
        } else {
          run.requests.push({
            estimatedInputTokens: 0,
            inputTokens,
            messages: [],
            model: typeof data.model === "string" ? data.model : run.model,
            outputTokens,
            requestIndex: run.requests.length + 1,
            seq: event.seq,
            systemPrompt: "",
            timestamp: event.timestamp,
            tools: [],
          });
        }
        break;
      }
      case HarnessEventType.MESSAGE_COMPLETED: {
        const run = runOf(event);
        if (data.hidden === true) break;
        const message = data.message as AgentMessage | undefined;
        if (message === undefined || (message.role !== "user" && message.role !== "assistant")) {
          break;
        }
        const text = messageText(message).trim();
        if (text === "") break;
        run.messages.push({
          role: message.role,
          seq: event.seq,
          text: truncate(text),
          timestamp: message.timestamp ?? event.timestamp,
        });
        break;
      }
      case HarnessEventType.TOOL_STARTED: {
        const run = runOf(event);
        const toolCallId =
          typeof data.toolCallId === "string" ? data.toolCallId : `tool-${event.seq}`;
        const tool: TraceTool = {
          endedAt: null,
          error: null,
          input: bounded(data.input),
          result: null,
          startedAt: event.timestamp,
          status: "running",
          toolCallId,
          toolName: typeof data.toolName === "string" ? data.toolName : "tool",
        };
        toolsOf(run).set(toolCallId, tool);
        run.tools.push(tool);
        break;
      }
      case HarnessEventType.TOOL_COMPLETED:
      case HarnessEventType.TOOL_FAILED: {
        const run = runOf(event);
        const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
        const tool = toolsOf(run).get(toolCallId);
        if (tool === undefined) break;
        tool.endedAt = event.timestamp;
        if (event.type === HarnessEventType.TOOL_FAILED) {
          tool.status = "failed";
          tool.error = stringOrNull(data.error);
        } else {
          tool.status = "completed";
          tool.result = truncate(stringOrNull(data.result) ?? "");
        }
        break;
      }
      case HarnessEventType.APPROVAL_REQUESTED: {
        const run = runOf(event);
        const approvalId =
          typeof data.approvalId === "string" ? data.approvalId : `approval-${event.seq}`;
        const approval: TraceApproval = {
          approvalId,
          decision: null,
          requestedAt: event.timestamp,
          resolvedAt: null,
          risk: data.risk === "high" ? "high" : data.risk === "normal" ? "normal" : null,
          summary: typeof data.summary === "string" ? data.summary : "",
          toolName: typeof data.toolName === "string" ? data.toolName : "tool",
        };
        approvalsOf(run).set(approvalId, approval);
        run.approvals.push(approval);
        break;
      }
      case HarnessEventType.APPROVAL_RESOLVED: {
        const run = runOf(event);
        const approvalId = typeof data.approvalId === "string" ? data.approvalId : "";
        const approval = approvalsOf(run).get(approvalId);
        if (approval === undefined) break;
        approval.decision = data.decision === "approved" ? "approved" : "denied";
        approval.resolvedAt = event.timestamp;
        break;
      }
      case HarnessEventType.CONTEXT_COMPACTED: {
        const run = runOf(event);
        run.compactions.push({
          afterTokens: numberOrZero(data.afterTokens),
          beforeTokens: numberOrZero(data.beforeTokens),
          checkpointId: typeof data.checkpointId === "string" ? data.checkpointId : null,
          seq: event.seq,
          summary: truncate(typeof data.summary === "string" ? data.summary : ""),
          timestamp: event.timestamp,
          trigger: data.trigger === "manual" ? "manual" : data.trigger === "auto" ? "auto" : null,
        });
        break;
      }
      case HarnessEventType.SUBAGENT_QUEUED:
      case HarnessEventType.SUBAGENT_STARTED:
      case HarnessEventType.SUBAGENT_TEXT_DELTA:
      case HarnessEventType.SUBAGENT_MESSAGE_COMPLETED:
      case HarnessEventType.SUBAGENT_TOOL_STARTED:
      case HarnessEventType.SUBAGENT_TOOL_COMPLETED:
      case HarnessEventType.SUBAGENT_TOOL_FAILED:
      case HarnessEventType.SUBAGENT_COMPLETED:
      case HarnessEventType.SUBAGENT_FAILED:
      case HarnessEventType.SUBAGENT_ABORTED: {
        const run = runOf(event);
        applySubAgentEvent(event.type, data, event, subAgentsOf(run));
        break;
      }
      case HarnessEventType.RUN_COMPLETED: {
        const run = runOf(event);
        run.status = "completed";
        run.steps = numberOrZero(data.steps);
        run.endedAt = event.timestamp;
        break;
      }
      case HarnessEventType.RUN_FAILED: {
        const run = runOf(event);
        run.status = "failed";
        run.endedAt = event.timestamp;
        break;
      }
      case HarnessEventType.RUN_ABORTED: {
        const run = runOf(event);
        run.status = "aborted";
        run.endedAt = event.timestamp;
        break;
      }
      default:
        break;
    }
  }

  for (const run of runs.values()) {
    run.subAgents = [...(subAgentMaps.get(run.runId)?.values() ?? [])];
    run.subAgents.sort((left, right) => left.startedAt - right.startedAt);
  }
  return [...runs.values()].sort((left, right) => left.startedAt - right.startedAt);
}

function applySubAgentEvent(
  type: HarnessEvent["type"],
  data: Record<string, unknown>,
  event: HarnessEvent,
  map: Map<string, TraceSubAgent>,
): void {
  const executionId = typeof data.executionId === "string" ? data.executionId : null;
  if (executionId === null) return;
  let agent = map.get(executionId);
  if (agent === undefined) {
    agent = {
      agentType: typeof data.agentType === "string" ? data.agentType : "worker",
      endedAt: null,
      errorCode: null,
      executionId,
      messages: [],
      modelId: typeof data.modelId === "string" ? data.modelId : "",
      name: typeof data.name === "string" ? data.name : executionId,
      parentExecutionId: typeof data.parentExecutionId === "string" ? data.parentExecutionId : null,
      startedAt: event.timestamp,
      status: "queued",
      task: typeof data.task === "string" ? truncate(data.task) : "",
      tools: [],
      usage: null,
    };
    map.set(executionId, agent);
  }
  if (agent.messages.length >= MAX_SUBAGENT_EVENTS || agent.tools.length >= MAX_SUBAGENT_EVENTS) {
    return;
  }
  if (type === HarnessEventType.SUBAGENT_STARTED) {
    agent.status = "running";
    agent.startedAt = event.timestamp;
    if (typeof data.modelId === "string") agent.modelId = data.modelId;
  } else if (
    type === HarnessEventType.SUBAGENT_TEXT_DELTA ||
    type === HarnessEventType.SUBAGENT_MESSAGE_COMPLETED
  ) {
    const message = asRecord(data.message);
    const text = typeof message.text === "string" ? message.text : textOfMessage(message);
    if (text !== "") {
      agent.messages.push({
        role: typeof message.role === "string" ? message.role : "assistant",
        text: truncate(text),
        timestamp: event.timestamp,
      });
    }
  } else if (type === HarnessEventType.SUBAGENT_TOOL_STARTED) {
    agent.tools.push({
      endedAt: null,
      error: null,
      input: bounded(data.input),
      result: null,
      startedAt: event.timestamp,
      status: "running",
      toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : `${event.seq}`,
      toolName: typeof data.toolName === "string" ? data.toolName : "tool",
    });
  } else if (
    type === HarnessEventType.SUBAGENT_TOOL_COMPLETED ||
    type === HarnessEventType.SUBAGENT_TOOL_FAILED
  ) {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const tool = agent.tools.find((item) => item.toolCallId === toolCallId);
    if (tool !== undefined) {
      tool.endedAt = event.timestamp;
      if (type === HarnessEventType.SUBAGENT_TOOL_FAILED) {
        tool.status = "failed";
        tool.error = stringOrNull(data.error);
      } else {
        tool.status = "completed";
        tool.result = truncate(stringOrNull(data.result) ?? "");
      }
    }
  } else if (
    type === HarnessEventType.SUBAGENT_COMPLETED ||
    type === HarnessEventType.SUBAGENT_FAILED ||
    type === HarnessEventType.SUBAGENT_ABORTED
  ) {
    agent.status =
      type === HarnessEventType.SUBAGENT_COMPLETED
        ? "completed"
        : type === HarnessEventType.SUBAGENT_FAILED
          ? "failed"
          : "aborted";
    agent.endedAt = event.timestamp;
    agent.errorCode = typeof data.errorCode === "string" ? data.errorCode : null;
    const usage = asRecord(data.usage);
    agent.usage = {
      inputTokens: numberOrZero(usage.inputTokens),
      outputTokens: numberOrZero(usage.outputTokens),
    };
  }
}

function textOfMessage(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n");
}

function bounded(value: unknown): unknown {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(bounded);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, bounded(item)]),
    );
  }
  return value;
}

function truncate(value: string): string {
  return value.length > MAX_PREVIEW_CHARS
    ? `${value.slice(0, MAX_PREVIEW_CHARS)}…[truncated]`
    : value;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
