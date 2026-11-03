import type { AgentMessage } from "@harness/core";
import {
  Ban,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquare,
  Wrench,
  XCircle,
} from "lucide-react";
import type { SubAgentState } from "../stores/chat-store";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

const STATUS_LABEL = {
  aborted: "已中止",
  completed: "已完成",
  failed: "失败",
  pending: "待调度",
  running: "运行中",
} as const;

function messageText(message: AgentMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

export function SubAgentPanel({ agents }: { agents: readonly SubAgentState[] }) {
  if (agents.length === 0) return null;
  return (
    <section className="subagent-group">
      <div className="tool-group-label">子 Agent（{agents.length}）</div>
      {agents.map((agent) => (
        <SubAgentCard agent={agent} key={agent.executionId} />
      ))}
    </section>
  );
}

export function SubAgentCard({
  agent,
  defaultOpen = false,
}: {
  agent: SubAgentState;
  defaultOpen?: boolean;
}) {
  const StatusIcon =
    agent.status === "pending"
      ? Clock
      : agent.status === "running"
        ? Loader2
        : agent.status === "completed"
          ? CheckCircle2
          : agent.status === "aborted"
            ? Ban
            : XCircle;
  return (
    <details
      className={`subagent-card subagent-${agent.status}`}
      open={
        defaultOpen ||
        agent.status === "running" ||
        agent.status === "failed" ||
        agent.status === "pending"
      }
    >
      <summary>
        <span className="subagent-icon">
          <Bot size={15} />
        </span>
        <span className="subagent-name">{agent.name}</span>
        <span className="subagent-type">{agent.agentType}</span>
        <span className={`subagent-status status-${agent.status}`}>
          <StatusIcon className={agent.status === "running" ? "spin" : undefined} size={12} />
          {STATUS_LABEL[agent.status]}
        </span>
        <span className="subagent-counts">
          <Wrench size={11} /> {agent.tools.length}
          <MessageSquare size={11} />{" "}
          {agent.messages.filter((message) => messageText(message)).length}
        </span>
        <ChevronDown className="tool-chevron" size={14} />
      </summary>
      <div className="subagent-body">
        <div className="subagent-task">
          <span className="tool-section-label">任务</span>
          <p>{agent.task}</p>
        </div>
        {agent.errorCode !== null ? <div className="inline-error">{agent.errorCode}</div> : null}
        {agent.resultSummary !== null ? (
          <div className="subagent-result">
            <span className="tool-section-label">结果</span>
            <Markdown>{agent.resultSummary}</Markdown>
          </div>
        ) : null}
        {agent.streamingText !== "" ? (
          <div className="subagent-result">
            <span className="tool-section-label">实时输出</span>
            <Markdown>{agent.streamingText}</Markdown>
            <span className="caret" />
          </div>
        ) : null}
        {agent.messages.filter((message) => messageText(message) !== "").length > 0 ? (
          <div className="subagent-messages">
            <span className="tool-section-label">对话</span>
            {agent.messages
              .filter((message) => messageText(message) !== "")
              .map((message) => (
                <div
                  className={`subagent-message ${message.role}`}
                  key={`${message.role}-${message.timestamp}-${messageText(message).slice(0, 20)}`}
                >
                  {message.role === "assistant" ? (
                    <Markdown>{messageText(message)}</Markdown>
                  ) : (
                    <span>{messageText(message)}</span>
                  )}
                </div>
              ))}
          </div>
        ) : null}
        {agent.tools.length > 0 ? (
          <div className="subagent-tools">
            <span className="tool-section-label">工具</span>
            {agent.tools.map((tool) => (
              <ToolCard
                key={tool.toolCallId}
                tool={{
                  ...(tool.error === undefined ? {} : { error: tool.error }),
                  id: tool.toolCallId,
                  input: tool.input,
                  name: tool.toolName,
                  ...(tool.result === undefined ? {} : { result: tool.result }),
                  status: tool.status,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}
