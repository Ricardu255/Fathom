import type { SubAgentStatus } from "@harness/core";
import { Bot, GitBranch, LayoutGrid, List } from "lucide-react";
import { useMemo, useState } from "react";
import type { SubAgentState } from "../stores/chat-store";
import { SubAgentCard } from "./SubAgentPanel";

type View = "board" | "graph" | "list";

const COLUMNS: readonly {
  color: string;
  id: string;
  label: string;
  statuses: readonly SubAgentStatus[];
}[] = [
  { color: "var(--muted-2)", id: "pending", label: "待开始", statuses: ["pending"] },
  { color: "var(--accent)", id: "running", label: "执行中", statuses: ["running"] },
  { color: "var(--red)", id: "issues", label: "需处理", statuses: ["failed", "aborted"] },
  { color: "var(--green)", id: "completed", label: "已完成", statuses: ["completed"] },
];

const STATUS_LABEL: Record<SubAgentStatus, string> = {
  aborted: "已中止",
  completed: "已完成",
  failed: "失败",
  pending: "待调度",
  running: "运行中",
};

export function SubAgentBoard({ agents }: { agents: readonly SubAgentState[] }) {
  const [view, setView] = useState<View>("board");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (agents.length === 0) return null;
  const running = agents.filter((agent) => agent.status === "running").length;
  const completed = agents.filter((agent) => agent.status === "completed").length;

  return (
    <section className="subagent-board">
      <div className="subagent-board-head">
        <div className="subagent-board-title">
          多 Agent 任务
          <span className="subagent-board-summary">
            {agents.length} 个节点 · {running} 执行中 · {completed} 已完成
          </span>
        </div>
        <div className="subagent-tabs" role="tablist">
          <button
            aria-selected={view === "board"}
            className={`subagent-tab${view === "board" ? " active" : ""}`}
            onClick={() => setView("board")}
            role="tab"
            type="button"
          >
            <LayoutGrid size={13} /> 看板
          </button>
          <button
            aria-selected={view === "graph"}
            className={`subagent-tab${view === "graph" ? " active" : ""}`}
            onClick={() => setView("graph")}
            role="tab"
            type="button"
          >
            <GitBranch size={13} /> 依赖图
          </button>
          <button
            aria-selected={view === "list"}
            className={`subagent-tab${view === "list" ? " active" : ""}`}
            onClick={() => setView("list")}
            role="tab"
            type="button"
          >
            <List size={13} /> 列表
          </button>
        </div>
      </div>
      {view === "board" ? (
        <BoardView
          agents={agents}
          onSelect={(id) => {
            setSelectedId(id);
            setView("list");
          }}
        />
      ) : null}
      {view === "graph" ? <GraphView agents={agents} /> : null}
      {view === "list" ? (
        <div className="subagent-list">
          {agents.map((agent) => (
            <SubAgentCard
              agent={agent}
              defaultOpen={agent.executionId === selectedId}
              key={agent.executionId}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BoardView({
  agents,
  onSelect,
}: {
  agents: readonly SubAgentState[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="subagent-columns">
      {COLUMNS.map((column) => {
        const items = agents.filter((agent) => column.statuses.includes(agent.status));
        return (
          <div className="subagent-column" key={column.id}>
            <div className="subagent-column-head">
              <span
                className="subagent-column-indicator"
                style={{ backgroundColor: column.color }}
              />
              <span>{column.label}</span>
              <span className="subagent-column-count">{items.length}</span>
            </div>
            <div className="subagent-column-body">
              {items.length === 0 ? (
                <div className="subagent-column-empty">暂无任务</div>
              ) : (
                items.map((agent) => (
                  <BoardCard
                    agent={agent}
                    key={agent.executionId}
                    onSelect={() => onSelect(agent.executionId)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardCard({ agent, onSelect }: { agent: SubAgentState; onSelect: () => void }) {
  const lastActivity = agent.messages.at(-1)?.timestamp ?? null;
  return (
    <button className={`board-card board-${agent.status}`} onClick={onSelect} type="button">
      <div className="board-card-head">
        <Bot size={13} />
        <span className="board-card-name">{agent.name}</span>
        <span className="board-card-type">{agent.agentType}</span>
      </div>
      <div className="board-card-task">{agent.resultSummary ?? agent.task ?? "（无任务描述）"}</div>
      <div className="board-card-chips">
        <span className="board-chip">{STATUS_LABEL[agent.status]}</span>
        {agent.dependsOn.length > 0 ? (
          <span className="board-chip">依赖 {agent.dependsOn.length}</span>
        ) : null}
        <span className="board-chip">{agent.tools.length} 工具</span>
      </div>
      {agent.errorCode !== null ? <div className="board-card-error">{agent.errorCode}</div> : null}
      <div className="board-card-meta">
        <span>{agent.messages.length} 条消息</span>
        {lastActivity !== null ? <span>{formatRelativeTime(lastActivity)}</span> : null}
      </div>
    </button>
  );
}

function formatRelativeTime(timestamp: number): string {
  const deltaMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (deltaMinutes < 1) return "刚刚更新";
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { day: "numeric", month: "short" }).format(timestamp);
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 58;
const H_GAP = 64;
const V_GAP = 14;
const PADDING = 18;

function GraphView({ agents }: { agents: readonly SubAgentState[] }) {
  const layout = useMemo(() => layoutGraph(agents), [agents]);
  return (
    <div className="subagent-graph-scroll">
      {layout.nodes.length === 0 ? (
        <div className="subagent-column-empty">—</div>
      ) : (
        <svg
          className="subagent-graph"
          height={layout.height}
          role="img"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
        >
          <title>子 Agent 依赖图</title>
          {layout.edges.map((edge) => (
            <path
              className={`dag-edge dag-edge-${edge.status}`}
              d={edge.path}
              fill="none"
              key={`${edge.from}-${edge.to}`}
              strokeWidth={1.4}
            />
          ))}
          {layout.nodes.map((node) => (
            <g className={`dag-node dag-${node.agent.status}`} key={node.agent.executionId}>
              <title>{node.agent.task}</title>
              <rect height={NODE_HEIGHT} rx={10} ry={10} width={NODE_WIDTH} x={node.x} y={node.y} />
              <text className="dag-node-name" x={node.x + 12} y={node.y + 23}>
                {clip(node.agent.name, 22)}
              </text>
              <text className="dag-node-meta" x={node.x + 12} y={node.y + 42}>
                {node.agent.agentType} · {STATUS_LABEL[node.agent.status]}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}

interface GraphNode {
  agent: SubAgentState;
  level: number;
  x: number;
  y: number;
}

interface GraphEdge {
  from: string;
  path: string;
  status: SubAgentStatus;
  to: string;
}

function layoutGraph(agents: readonly SubAgentState[]): {
  edges: GraphEdge[];
  height: number;
  nodes: GraphNode[];
  width: number;
} {
  const byId = new Map(agents.map((agent) => [agent.executionId, agent] as const));
  const levelCache = new Map<string, number>();
  const levelOf = (id: string, visiting: ReadonlySet<string>): number => {
    const cached = levelCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const agent = byId.get(id);
    if (agent === undefined) return 0;
    const nextVisiting = new Set(visiting).add(id);
    const dependencies = agent.dependsOn
      .map((dependency) => levelOf(dependency, nextVisiting))
      .filter((value) => Number.isFinite(value));
    const level = dependencies.length === 0 ? 0 : Math.max(...dependencies) + 1;
    levelCache.set(id, level);
    return level;
  };

  const groups = new Map<number, SubAgentState[]>();
  for (const agent of agents) {
    const level = levelOf(agent.executionId, new Set());
    const group = groups.get(level) ?? [];
    group.push(agent);
    groups.set(level, group);
  }
  const maxLevel = Math.max(...groups.keys(), 0);
  const maxRows = Math.max(...[...groups.values()].map((group) => group.length), 1);
  const width = PADDING * 2 + (maxLevel + 1) * NODE_WIDTH + maxLevel * H_GAP;
  const height = PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * V_GAP;

  const positions = new Map<string, GraphNode>();
  for (const [level, group] of groups) {
    group.sort((left, right) => left.name.localeCompare(right.name));
    for (const [row, agent] of group.entries()) {
      positions.set(agent.executionId, {
        agent,
        level,
        x: PADDING + level * (NODE_WIDTH + H_GAP),
        y: PADDING + row * (NODE_HEIGHT + V_GAP),
      });
    }
  }

  const nodes = [...positions.values()];
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const dependencyId of node.agent.dependsOn) {
      const from = positions.get(dependencyId);
      if (from === undefined) continue;
      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = node.x;
      const y2 = node.y + NODE_HEIGHT / 2;
      const bend = Math.max(24, (x2 - x1) / 2);
      edges.push({
        from: dependencyId,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        status: node.agent.status,
        to: node.agent.executionId,
      });
    }
  }
  return { edges, height, nodes, width };
}

function clip(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}
