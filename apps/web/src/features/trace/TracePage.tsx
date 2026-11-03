import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Loader2,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { traceQueryOptions } from "../../api/queries";
import type {
  TraceApproval,
  TraceCompaction,
  TraceRequest,
  TraceRun,
  TraceSubAgent,
  TraceTool,
} from "../../api/types";

export function TracePage({ sessionId }: { sessionId: string }) {
  return (
    <div className="trace-page">
      <header className="page-header">
        <div>
          <Link className="trace-back" to={`/s/${encodeURIComponent(sessionId)}`}>
            <ArrowLeft size={13} /> 返回会话
          </Link>
          <h1>执行轨迹</h1>
        </div>
      </header>
      <TraceView sessionId={sessionId} />
    </div>
  );
}

export function TraceView({ sessionId }: { sessionId: string }) {
  const traceQuery = useQuery(traceQueryOptions(sessionId));
  const trace = traceQuery.data;
  const [selectedRequest, setSelectedRequest] = useState<TraceRequest | null>(null);
  const [executionId, setExecutionId] = useState("");
  const subAgents = trace?.runs.flatMap((run) => run.subAgents) ?? [];
  const selectedSubAgent = subAgents.find((agent) => agent.executionId === executionId) ?? null;

  return (
    <>
      {traceQuery.isPending ? (
        <div className="page-loading">
          <Loader2 className="spin" size={16} /> 读取 Trace…
        </div>
      ) : traceQuery.error !== null || trace === undefined ? (
        <div className="inline-error">{traceQuery.error?.message ?? "无法读取 Trace"}</div>
      ) : (
        <>
          <div className="trace-toolbar">
            <label>
              子 Agent
              <select onChange={(event) => setExecutionId(event.target.value)} value={executionId}>
                <option value="">全部</option>
                {subAgents.map((agent) => (
                  <option key={agent.executionId} value={agent.executionId}>
                    {agent.name} · {agent.agentType}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted-text">
              {trace.runs.length} 个 Run · {subAgents.length} 个子 Agent
            </span>
          </div>

          {selectedSubAgent !== null ? (
            <SubAgentTrace agent={selectedSubAgent} />
          ) : (
            <div className="trace-runs">
              {trace.runs.map((run) => (
                <RunCard key={run.runId} onSelectRequest={setSelectedRequest} run={run} />
              ))}
            </div>
          )}
        </>
      )}

      {selectedRequest !== null ? (
        <RequestDetail request={selectedRequest} onClose={() => setSelectedRequest(null)} />
      ) : null}
    </>
  );
}

function RunCard({
  onSelectRequest,
  run,
}: {
  onSelectRequest: (request: TraceRequest) => void;
  run: TraceRun;
}) {
  return (
    <section className="trace-run">
      <header className="trace-run-head">
        <span className={`trace-status ${run.status}`}>
          {run.status === "running" ? <Loader2 className="spin" size={12} /> : null}
          {run.status === "completed" ? <CheckCircle2 size={12} /> : null}
          {run.status === "failed" || run.status === "aborted" ? <XCircle size={12} /> : null}
          {run.status}
        </span>
        <strong>{run.model || "未知模型"}</strong>
        <span className="muted-text">
          {new Date(run.startedAt).toLocaleString()} · {run.steps} 步
        </span>
      </header>
      <RunSwimlane onSelectRequest={onSelectRequest} run={run} />
      <div className="trace-timeline">
        {(run.messages ?? []).map((message) => (
          <div
            className={`trace-event trace-message ${message.role}`}
            id={`trace-message-${message.seq}`}
            key={`message-${message.seq}`}
          >
            <Bot size={12} />
            <span>{message.role}</span>
            <small>{message.text.slice(0, 500)}</small>
          </div>
        ))}
        {run.requests.map((request) => (
          <button
            className="trace-event trace-request"
            key={`request-${request.seq}`}
            onClick={() => onSelectRequest(request)}
            type="button"
          >
            <Cpu size={12} />
            <span>
              请求 #{request.requestIndex} · {request.model}
            </span>
            <small>
              {formatTokens(request.inputTokens)} in / {formatTokens(request.outputTokens)} out
              {request.estimatedInputTokens > 0
                ? ` · 估算 ${formatTokens(request.estimatedInputTokens)}`
                : ""}
            </small>
          </button>
        ))}
        {run.tools.map((tool) => (
          <ToolEntry key={tool.toolCallId} tool={tool} />
        ))}
        {run.approvals.map((approval) => (
          <ApprovalEntry approval={approval} key={approval.approvalId} />
        ))}
        {run.compactions.map((compaction) => (
          <CompactionEntry compaction={compaction} key={compaction.seq} />
        ))}
        {run.subAgents.map((agent) => (
          <div className="trace-event trace-subagent" key={agent.executionId}>
            <Bot size={12} />
            <span>
              {agent.name} · {agent.agentType}
            </span>
            <small>
              {agent.status}
              {agent.usage === null
                ? ""
                : ` · ${formatTokens(agent.usage.inputTokens)} in / ${formatTokens(agent.usage.outputTokens)} out`}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunSwimlane({
  onSelectRequest,
  run,
}: {
  onSelectRequest: (request: TraceRequest) => void;
  run: TraceRun;
}) {
  const now = Date.now();
  const start = run.startedAt;
  const end = Math.max(run.endedAt ?? now, start + 1);
  const span = Math.max(end - start, 1);
  const pct = (timestamp: number) =>
    `${Math.min(100, Math.max(0, ((timestamp - start) / span) * 100))}%`;
  const width = (from: number, to: number) =>
    `${Math.max(0.8, Math.min(100, ((to - from) / span) * 100))}%`;
  const inputMessages = (run.messages ?? []).filter((message) => message.role === "user");
  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <section aria-label={`Run ${run.runId} 执行泳道`} className="trace-swimlane">
      <div className="trace-swimlane-axis">
        <span>{formatTimePrecise(start)}</span>
        <span>{formatDuration(span)}</span>
        <span>{run.endedAt === null ? "进行中" : formatTimePrecise(end)}</span>
      </div>
      <div className="trace-lane">
        <div className="trace-lane-label">
          <span>输入</span>
          <small>{inputMessages.length}</small>
        </div>
        <div className="trace-lane-track">
          {inputMessages.map((message) => (
            <button
              aria-label={`输入消息：${message.text.slice(0, 80)}`}
              className="trace-lane-dot input"
              key={`input-${message.seq}`}
              onClick={() => scrollTo(`trace-message-${message.seq}`)}
              style={{ left: pct(message.timestamp) }}
              title={message.text.slice(0, 240)}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="trace-lane">
        <div className="trace-lane-label">
          <span>模型</span>
          <small>{run.requests.length}</small>
        </div>
        <div className="trace-lane-track">
          {run.requests.map((request) => (
            <button
              aria-label={`请求 #${request.requestIndex}`}
              className="trace-lane-dot model"
              key={`request-${request.seq}`}
              onClick={() => onSelectRequest(request)}
              style={{ left: pct(request.timestamp) }}
              title={`#${request.requestIndex} ${request.model} · ${formatTokens(request.inputTokens)} in / ${formatTokens(request.outputTokens)} out`}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="trace-lane tool-lane">
        <div className="trace-lane-label">
          <span>工具</span>
          <small>{run.tools.length}</small>
        </div>
        <div className="trace-lane-track">
          {run.tools.map((tool, index) => (
            <button
              aria-label={`${tool.toolName} ${tool.status}`}
              className={`trace-lane-bar ${tool.status}`}
              key={tool.toolCallId}
              onClick={() => scrollTo(`trace-tool-${tool.toolCallId}`)}
              style={{
                left: pct(tool.startedAt),
                top: `${7 + (index % 2) * 11}px`,
                width: width(tool.startedAt, tool.endedAt ?? end),
              }}
              title={`${tool.toolName} · ${tool.status} · ${formatDuration(
                (tool.endedAt ?? end) - tool.startedAt,
              )}`}
              type="button"
            />
          ))}
          {run.approvals.map((approval) => (
            <button
              aria-label={`审批 ${approval.toolName}`}
              className="trace-lane-marker approval"
              key={approval.approvalId}
              onClick={() => scrollTo(`trace-approval-${approval.approvalId}`)}
              style={{ left: pct(approval.requestedAt) }}
              title={`审批 · ${approval.toolName} · ${approval.decision ?? "pending"}`}
              type="button"
            />
          ))}
          {run.compactions.map((compaction) => (
            <button
              aria-label="上下文压缩"
              className="trace-lane-marker compaction"
              key={`compaction-${compaction.seq}`}
              onClick={() => scrollTo(`trace-compaction-${compaction.seq}`)}
              style={{ left: pct(compaction.timestamp) }}
              title={`上下文压缩 · ${formatTokens(compaction.beforeTokens)} → ${formatTokens(
                compaction.afterTokens,
              )}`}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="trace-swimlane-legend">
        <span>
          <i className="legend-dot input" /> 输入
        </span>
        <span>
          <i className="legend-dot model" /> 模型
        </span>
        <span>
          <i className="legend-bar" /> 工具
        </span>
        <span>
          <i className="legend-marker" /> 审批 / 压缩
        </span>
      </div>
    </section>
  );
}

function ToolEntry({ tool }: { tool: TraceTool }) {
  return (
    <details
      className={`trace-event trace-tool ${tool.status}`}
      id={`trace-tool-${tool.toolCallId}`}
    >
      <summary>
        <Wrench size={12} />
        <span>{tool.toolName}</span>
        <small>{tool.status}</small>
      </summary>
      <div className="trace-detail">
        <strong>参数</strong>
        <pre>{stringify(tool.input)}</pre>
        {tool.result !== null ? (
          <>
            <strong>结果</strong>
            <pre>{tool.result.slice(0, 8_000)}</pre>
          </>
        ) : null}
        {tool.error !== null ? <p className="inline-error">{tool.error}</p> : null}
      </div>
    </details>
  );
}

function ApprovalEntry({ approval }: { approval: TraceApproval }) {
  return (
    <div className="trace-event trace-approval" id={`trace-approval-${approval.approvalId}`}>
      <ShieldCheck size={12} />
      <span>
        {approval.toolName} · {approval.summary}
      </span>
      <small>{approval.decision ?? "pending"}</small>
    </div>
  );
}

function CompactionEntry({ compaction }: { compaction: TraceCompaction }) {
  return (
    <div className="trace-event trace-compaction" id={`trace-compaction-${compaction.seq}`}>
      <Clock size={12} />
      <span>上下文压缩 {compaction.trigger === "manual" ? "手动" : "自动"}</span>
      <small>
        {formatTokens(compaction.beforeTokens)} → {formatTokens(compaction.afterTokens)}
      </small>
    </div>
  );
}

function SubAgentTrace({ agent }: { agent: TraceSubAgent }) {
  return (
    <section className="trace-run">
      <header className="trace-run-head">
        <span className={`trace-status ${agent.status}`}>{agent.status}</span>
        <strong>{agent.name}</strong>
        <span className="muted-text">
          {agent.agentType} · {agent.modelId}
        </span>
      </header>
      <p className="trace-task">{agent.task}</p>
      <SubAgentSwimlane agent={agent} />
      <div className="trace-timeline">
        {agent.messages.map((message, index) => (
          <div
            className="trace-event trace-message"
            id={`subagent-message-${agent.executionId}-${index}`}
            key={`${message.timestamp}-${message.role}-${message.text.slice(0, 32)}`}
          >
            <Bot size={12} />
            <span>{message.role}</span>
            <small>{message.text.slice(0, 500)}</small>
          </div>
        ))}
        {agent.tools.map((tool) => (
          <ToolEntry key={tool.toolCallId} tool={tool} />
        ))}
      </div>
    </section>
  );
}

function SubAgentSwimlane({ agent }: { agent: TraceSubAgent }) {
  const now = Date.now();
  const start = agent.startedAt;
  const end = Math.max(agent.endedAt ?? now, start + 1);
  const span = Math.max(end - start, 1);
  const pct = (timestamp: number) =>
    `${Math.min(100, Math.max(0, ((timestamp - start) / span) * 100))}%`;
  const width = (from: number, to: number) =>
    `${Math.max(0.8, Math.min(100, ((to - from) / span) * 100))}%`;
  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

  return (
    <section aria-label={`${agent.name} 执行泳道`} className="trace-swimlane subagent">
      <div className="trace-swimlane-axis">
        <span>{formatTimePrecise(start)}</span>
        <span>{formatDuration(span)}</span>
        <span>{agent.endedAt === null ? "进行中" : formatTimePrecise(end)}</span>
      </div>
      <div className="trace-lane">
        <div className="trace-lane-label">
          <span>消息</span>
          <small>{agent.messages.length}</small>
        </div>
        <div className="trace-lane-track">
          {agent.messages.map((message, index) => (
            <button
              aria-label={`${message.role} 消息`}
              className={`trace-lane-dot ${message.role === "user" ? "input" : "model"}`}
              key={`${message.timestamp}-${message.role}-${message.text.slice(0, 32)}`}
              onClick={() => scrollTo(`subagent-message-${agent.executionId}-${index}`)}
              style={{ left: pct(Math.max(start, message.timestamp)) }}
              title={message.text.slice(0, 240)}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="trace-lane tool-lane">
        <div className="trace-lane-label">
          <span>工具</span>
          <small>{agent.tools.length}</small>
        </div>
        <div className="trace-lane-track">
          {agent.tools.map((tool, index) => (
            <button
              aria-label={`${tool.toolName} ${tool.status}`}
              className={`trace-lane-bar ${tool.status}`}
              key={tool.toolCallId}
              onClick={() => scrollTo(`trace-tool-${tool.toolCallId}`)}
              style={{
                left: pct(tool.startedAt),
                top: `${7 + (index % 2) * 11}px`,
                width: width(tool.startedAt, tool.endedAt ?? end),
              }}
              title={`${tool.toolName} · ${tool.status} · ${formatDuration(
                (tool.endedAt ?? end) - tool.startedAt,
              )}`}
              type="button"
            />
          ))}
        </div>
      </div>
      <div className="trace-swimlane-legend">
        <span>
          <i className="legend-dot input" /> 用户
        </span>
        <span>
          <i className="legend-dot model" /> 助手
        </span>
        <span>
          <i className="legend-bar" /> 工具
        </span>
      </div>
    </section>
  );
}

function RequestDetail({ onClose, request }: { onClose: () => void; request: TraceRequest }) {
  const [tab, setTab] = useState<"messages" | "prompt" | "summary" | "tools">("summary");
  return (
    <div className="dialog-backdrop">
      <div
        aria-modal="true"
        className="dialog-panel dialog-wide trace-request-dialog"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2>请求 #{request.requestIndex}</h2>
            <div className="branch-tree-sub">
              {request.model} · {new Date(request.timestamp).toLocaleString()} · seq {request.seq}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} type="button">
            关闭
          </button>
        </div>
        <div className="trace-tabs">
          {(["summary", "messages", "prompt", "tools"] as const).map((item) => (
            <button
              className={`trace-tab${tab === item ? " active" : ""}`}
              key={item}
              onClick={() => setTab(item)}
              type="button"
            >
              {item === "summary"
                ? "概要"
                : item === "messages"
                  ? "消息"
                  : item === "prompt"
                    ? "System Prompt"
                    : "工具定义"}
            </button>
          ))}
        </div>
        <div className="dialog-body">
          {tab === "summary" ? (
            <div className="trace-request-summary">
              <dl>
                <div>
                  <dt>模型</dt>
                  <dd>{request.model}</dd>
                </div>
                <div>
                  <dt>请求</dt>
                  <dd>#{request.requestIndex}</dd>
                </div>
                <div>
                  <dt>时间</dt>
                  <dd>{formatTime(request.timestamp)}</dd>
                </div>
                <div>
                  <dt>输入</dt>
                  <dd>{formatTokens(request.inputTokens)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{formatTokens(request.outputTokens)}</dd>
                </div>
                <div>
                  <dt>估算输入</dt>
                  <dd>{formatTokens(request.estimatedInputTokens)}</dd>
                </div>
                <div>
                  <dt>消息数</dt>
                  <dd>{request.messages.length}</dd>
                </div>
                <div>
                  <dt>工具数</dt>
                  <dd>{request.tools.length}</dd>
                </div>
                <div>
                  <dt>事件 seq</dt>
                  <dd>{request.seq}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <pre className="trace-json">
              {tab === "messages"
                ? stringify(request.messages)
                : tab === "prompt"
                  ? request.systemPromptUnchanged === true
                    ? UNCHANGED_SNAPSHOT_HINT
                    : request.systemPrompt
                  : request.toolsUnchanged === true
                    ? UNCHANGED_SNAPSHOT_HINT
                    : stringify(request.tools)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

const UNCHANGED_SNAPSHOT_HINT = "（与上一份请求快照相同，未重复记录）";

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTimePrecise(timestamp: number): string {
  const date = new Date(timestamp);
  return `${formatTime(timestamp)}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}
