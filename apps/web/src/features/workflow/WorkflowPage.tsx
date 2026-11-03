import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, GitFork, Loader2, Play, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch } from "../../api/client";
import { queryKeys, workflowsQueryOptions } from "../../api/queries";
import type { Session, TriggerCondition, WorkflowNodeSpec, WorkflowRecord } from "../../api/types";
import { WorkflowHistoryDialog } from "../../components/WorkflowHistoryDialog";
import {
  createWorkflowNode,
  createWorkflowTemplate,
  validateWorkflow,
  type WorkflowAgentType,
  type WorkflowNodeDraft,
} from "./workflow-model";

const AGENT_LABEL: Record<WorkflowAgentType, string> = {
  explorer: "调研 / 只读",
  reviewer: "审查 / 只读",
  worker: "执行 / 可写",
};

export function WorkflowPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workflowsQuery = useQuery(workflowsQueryOptions());
  const [nodes, setNodes] = useState<WorkflowNodeDraft[]>([createWorkflowNode(1)]);
  const [title, setTitle] = useState("我的工作流");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"running" | "saving" | null>(null);
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [scheduleCron, setScheduleCron] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(localTimezone);
  const [conditionType, setConditionType] = useState<TriggerCondition["type"]>("always");
  const [conditionValue, setConditionValue] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookToken, setWebhookToken] = useState<string | null>(null);
  const [fileWatchEnabled, setFileWatchEnabled] = useState(false);
  const [fileWatchPaths, setFileWatchPaths] = useState("");
  const [historyWorkflow, setHistoryWorkflow] = useState<WorkflowRecord | null>(null);

  const updateNode = (id: string, patch: Partial<WorkflowNodeDraft>) => {
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, ...patch } : node)));
    setNotice(null);
  };

  const removeNode = (id: string) => {
    setNodes((current) =>
      current
        .filter((node) => node.id !== id)
        .map((node) => ({
          ...node,
          dependsOn: node.dependsOn.filter((dependency) => dependency !== id),
        })),
    );
    setNotice(null);
  };

  const addNode = () => {
    setNodes((current) => [...current, createWorkflowNode(nextNodeNumber(current))]);
    setNotice(null);
  };

  const applyTemplate = () => {
    setNodes(createWorkflowTemplate());
    setTitle("调研到审查");
    setScheduleCron("");
    setScheduleTimezone(localTimezone);
    setConditionType("always");
    setConditionValue("");
    setWebhookEnabled(false);
    setWebhookToken(null);
    setFileWatchEnabled(false);
    setFileWatchPaths("");
    setSavedId(null);
    setErrors([]);
    setNotice(null);
  };

  const loadSaved = (workflow: WorkflowRecord) => {
    setSavedId(workflow.id);
    setTitle(workflow.title);
    setScheduleCron(workflow.scheduleCron ?? cronFromInterval(workflow.scheduleIntervalMinutes));
    setScheduleTimezone(workflow.scheduleTimezone ?? localTimezone);
    setConditionType(workflow.triggerCondition.type);
    setConditionValue(
      workflow.triggerCondition.type === "always" ? "" : workflow.triggerCondition.value,
    );
    setWebhookEnabled(workflow.webhookToken !== null);
    setWebhookToken(workflow.webhookToken);
    setFileWatchEnabled(workflow.fileWatchEnabled);
    setFileWatchPaths(workflow.fileWatchPaths.join(", "));
    setNodes(
      workflow.nodes.map((node, index) => ({
        agentType: node.agentType ?? "worker",
        dependsOn: [...(node.dependsOn ?? [])],
        id: node.id,
        task: node.task,
        title: node.title ?? `节点 ${index + 1}`,
      })),
    );
    setErrors([]);
    setNotice(`已载入「${workflow.title}」`);
  };

  const persist = async (): Promise<WorkflowRecord> => {
    const validation = validateWorkflow(nodes);
    setErrors(validation);
    if (validation.length > 0) throw new Error("工作流校验失败");
    const payload = {
      fileWatchEnabled,
      fileWatchPaths: fileWatchPaths
        .split(/[\n,]/u)
        .map((path) => path.trim())
        .filter((path) => path !== ""),
      nodes: nodes.map(toNodeSpec),
      scheduleCron: scheduleCron.trim() === "" ? null : scheduleCron.trim(),
      scheduleIntervalMinutes: null,
      scheduleTimezone: scheduleCron.trim() === "" ? null : scheduleTimezone,
      title: title.trim() === "" ? "未命名工作流" : title.trim(),
      triggerCondition:
        conditionType === "always"
          ? ({ type: "always" } satisfies TriggerCondition)
          : ({ type: conditionType, value: conditionValue } satisfies TriggerCondition),
      webhookEnabled,
    };
    const record =
      savedId === null
        ? await apiFetch<WorkflowRecord>("/api/workflows", {
            body: JSON.stringify(payload),
            method: "POST",
          })
        : await apiFetch<WorkflowRecord>(`/api/workflows/${encodeURIComponent(savedId)}`, {
            body: JSON.stringify(payload),
            method: "PUT",
          });
    setSavedId(record.id);
    setWebhookToken(record.webhookToken);
    await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    return record;
  };

  const save = async () => {
    setBusy("saving");
    setErrors([]);
    try {
      const record = await persist();
      setNotice(`已保存「${record.title}」`);
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === "工作流校验失败")) {
        setErrors([error instanceof Error ? error.message : "保存工作流失败"]);
      }
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setBusy("running");
    setErrors([]);
    try {
      const record = await persist();
      const result = await apiFetch<{ runId: string; session: Session }>(
        `/api/workflows/${encodeURIComponent(record.id)}/run`,
        { method: "POST" },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      navigate(`/s/${result.session.id}`);
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === "工作流校验失败")) {
        setErrors([error instanceof Error ? error.message : "启动工作流失败"]);
      }
    } finally {
      setBusy(null);
    }
  };

  const deleteSaved = async (workflow: WorkflowRecord) => {
    if (!window.confirm(`删除工作流「${workflow.title}」？`)) return;
    try {
      await apiFetch<void>(`/api/workflows/${encodeURIComponent(workflow.id)}`, {
        method: "DELETE",
      });
      if (savedId === workflow.id) {
        setSavedId(null);
        setNotice(null);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
    } catch (error: unknown) {
      setErrors([error instanceof Error ? error.message : "删除工作流失败"]);
    }
  };

  const runSaved = async (workflow: WorkflowRecord) => {
    setBusy("running");
    setErrors([]);
    try {
      const result = await apiFetch<{ runId: string; session: Session }>(
        `/api/workflows/${encodeURIComponent(workflow.id)}/run`,
        { method: "POST" },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflows });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      navigate(`/s/${result.session.id}`);
    } catch (error: unknown) {
      setErrors([error instanceof Error ? error.message : "启动工作流失败"]);
    } finally {
      setBusy(null);
    }
  };

  const saved = workflowsQuery.data ?? [];

  return (
    <div className="workflow-page">
      <header className="workflow-header">
        <div>
          <h1>工作流</h1>
          <p>保存、复用并直接运行子 Agent DAG；依赖完成后自动调度。</p>
        </div>
        <div className="workflow-header-actions">
          <button className="btn btn-ghost" onClick={applyTemplate} type="button">
            <Sparkles size={14} /> 示例模板
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => void save()}
            type="button"
          >
            {busy === "saving" ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
            保存
          </button>
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => void run()}
            type="button"
          >
            {busy === "running" ? <Loader2 className="spin" size={14} /> : <GitFork size={14} />}
            保存并运行
          </button>
        </div>
      </header>

      {errors.length > 0 ? (
        <div className="inline-error workflow-errors">
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      ) : null}
      {notice !== null ? <div className="workflow-notice">{notice}</div> : null}

      <div className="workflow-layout">
        <aside className="workflow-saved">
          <div className="workflow-saved-head">
            <span>已保存</span>
            <span>{saved.length}</span>
          </div>
          {workflowsQuery.isPending ? (
            <div className="muted-text">加载中…</div>
          ) : saved.length === 0 ? (
            <div className="muted-text">还没有保存的工作流。</div>
          ) : (
            saved.map((workflow) => (
              <article
                className={`workflow-saved-item${savedId === workflow.id ? " active" : ""}`}
                key={workflow.id}
              >
                <button
                  className="workflow-saved-load"
                  onClick={() => loadSaved(workflow)}
                  type="button"
                >
                  <span className="workflow-saved-title">{workflow.title}</span>
                  <span className="workflow-saved-meta">
                    {workflow.nodes.length} 个节点
                    {workflow.scheduleCron === null
                      ? workflow.scheduleIntervalMinutes === null
                        ? ""
                        : ` · 每 ${workflow.scheduleIntervalMinutes} 分钟`
                      : ` · ${workflow.scheduleCron}`}
                    {workflow.nextRunAt === null
                      ? ""
                      : ` · 下次 ${new Date(workflow.nextRunAt).toLocaleTimeString()}`}
                  </span>
                </button>
                <div className="workflow-saved-actions">
                  <button
                    aria-label={`运行工作流 ${workflow.title}`}
                    className="session-action"
                    disabled={busy !== null}
                    onClick={() => void runSaved(workflow)}
                    title="立即运行"
                    type="button"
                  >
                    <Play size={12} />
                  </button>
                  <button
                    aria-label={`查看运行历史 ${workflow.title}`}
                    className="session-action"
                    onClick={() => setHistoryWorkflow(workflow)}
                    title="运行历史"
                    type="button"
                  >
                    <Clock size={12} />
                  </button>
                  {workflow.lastRunSessionId !== null ? (
                    <Link
                      className="session-action"
                      title="打开最近运行"
                      to={`/s/${workflow.lastRunSessionId}`}
                    >
                      <GitFork size={12} />
                    </Link>
                  ) : null}
                  <button
                    aria-label={`删除工作流 ${workflow.title}`}
                    className="session-action"
                    onClick={() => void deleteSaved(workflow)}
                    type="button"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </article>
            ))
          )}
        </aside>

        <section className="workflow-nodes">
          <label className="workflow-title-field">
            <span>工作流标题</span>
            <input
              maxLength={120}
              onChange={(event) => {
                setTitle(event.target.value);
                setNotice(null);
              }}
              value={title}
            />
          </label>
          <label className="workflow-title-field">
            <span>cron 调度</span>
            <input
              aria-label="cron 表达式"
              onChange={(event) => {
                setScheduleCron(event.target.value);
                setNotice(null);
              }}
              placeholder="留空不调度，例如 */15 * * * *"
              value={scheduleCron}
            />
          </label>
          <div className="workflow-cron-presets">
            <button
              className="btn btn-ghost"
              onClick={() => setScheduleCron("*/15 * * * *")}
              type="button"
            >
              每 15 分钟
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setScheduleCron("0 * * * *")}
              type="button"
            >
              每小时
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setScheduleCron("0 0 * * *")}
              type="button"
            >
              每天
            </button>
          </div>
          {scheduleCron.trim() !== "" ? (
            <label className="workflow-title-field">
              <span>调度时区</span>
              <input
                aria-label="调度时区"
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="Asia/Shanghai"
                value={scheduleTimezone}
              />
            </label>
          ) : null}
          <div className="workflow-trigger-row">
            <label className="workflow-title-field">
              <span>触发条件</span>
              <select
                aria-label="触发条件类型"
                onChange={(event) => {
                  setConditionType(event.target.value as TriggerCondition["type"]);
                  setConditionValue("");
                }}
                value={conditionType}
              >
                <option value="always">总是触发</option>
                <option value="fileMatches">文件路径匹配</option>
                <option value="webhookContains">Webhook 内容包含</option>
              </select>
            </label>
            {conditionType !== "always" ? (
              <label className="workflow-title-field">
                <span>条件值</span>
                <input
                  aria-label="触发条件值"
                  onChange={(event) => setConditionValue(event.target.value)}
                  placeholder={conditionType === "fileMatches" ? "**/*.md" : "deploy"}
                  value={conditionValue}
                />
              </label>
            ) : null}
          </div>

          <section className="workflow-triggers">
            <label className="workflow-trigger-toggle">
              <input
                checked={webhookEnabled}
                onChange={(event) => {
                  setWebhookEnabled(event.target.checked);
                  setNotice(null);
                }}
                type="checkbox"
              />
              Webhook 触发
            </label>
            {webhookEnabled ? (
              <div className="workflow-webhook">
                {webhookToken === null || savedId === null ? (
                  <span className="muted-text">保存后生成 token</span>
                ) : (
                  <>
                    <code>
                      {window.location.origin}/api/workflows/{savedId}/webhook?token=
                      {webhookToken}
                    </code>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        void navigator.clipboard.writeText(
                          `${window.location.origin}/api/workflows/${savedId}/webhook?token=${webhookToken}`,
                        );
                        setNotice("Webhook URL 已复制");
                      }}
                      type="button"
                    >
                      复制
                    </button>
                  </>
                )}
              </div>
            ) : null}

            <label className="workflow-trigger-toggle">
              <input
                checked={fileWatchEnabled}
                onChange={(event) => {
                  setFileWatchEnabled(event.target.checked);
                  setNotice(null);
                }}
                type="checkbox"
              />
              文件变更触发
            </label>
            {fileWatchEnabled ? (
              <label className="workflow-title-field">
                <span>监听路径</span>
                <input
                  aria-label="文件监听路径"
                  onChange={(event) => {
                    setFileWatchPaths(event.target.value);
                    setNotice(null);
                  }}
                  placeholder="相对 workspace，例如 src, docs/notes.md"
                  value={fileWatchPaths}
                />
              </label>
            ) : null}
          </section>

          {nodes.map((node, index) => (
            <article className="workflow-node" key={node.id}>
              <div className="workflow-node-head">
                <span className="workflow-node-index">{index + 1}</span>
                <input
                  aria-label={`节点 ${index + 1} 标题`}
                  maxLength={120}
                  onChange={(event) => updateNode(node.id, { title: event.target.value })}
                  placeholder="节点标题"
                  value={node.title}
                />
                <select
                  aria-label={`节点 ${index + 1} 类型`}
                  onChange={(event) =>
                    updateNode(node.id, {
                      agentType: event.target.value as WorkflowAgentType,
                    })
                  }
                  value={node.agentType}
                >
                  {Object.entries(AGENT_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={`删除节点 ${index + 1}`}
                  className="session-action"
                  disabled={nodes.length <= 1}
                  onClick={() => removeNode(node.id)}
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                aria-label={`节点 ${index + 1} 任务`}
                maxLength={20_000}
                onChange={(event) => updateNode(node.id, { task: event.target.value })}
                placeholder="描述这个子 Agent 要完成什么、如何验收。"
                rows={3}
                value={node.task}
              />
              <div className="workflow-dependencies">
                <span>依赖：</span>
                {nodes.filter((item) => item.id !== node.id).length === 0 ? (
                  <span className="muted-text">暂无其他节点</span>
                ) : (
                  nodes
                    .filter((item) => item.id !== node.id)
                    .map((item) => (
                      <label className="workflow-dependency" key={item.id}>
                        <input
                          checked={node.dependsOn.includes(item.id)}
                          onChange={(event) =>
                            updateNode(node.id, {
                              dependsOn: event.target.checked
                                ? [...node.dependsOn, item.id]
                                : node.dependsOn.filter((id) => id !== item.id),
                            })
                          }
                          type="checkbox"
                        />
                        {item.title || item.id}
                      </label>
                    ))
                )}
              </div>
            </article>
          ))}
          <button
            className="workflow-add"
            disabled={nodes.length >= 12}
            onClick={addNode}
            type="button"
          >
            <Plus size={15} /> 添加节点
          </button>
        </section>
      </div>
      {historyWorkflow !== null ? (
        <WorkflowHistoryDialog
          onClose={() => setHistoryWorkflow(null)}
          workflow={historyWorkflow}
        />
      ) : null}
    </div>
  );
}

function toNodeSpec(node: WorkflowNodeDraft): WorkflowNodeSpec {
  return {
    agentType: node.agentType,
    dependsOn: node.dependsOn,
    id: node.id,
    task: node.task.trim(),
    title: node.title.trim() || node.id,
  };
}

function cronFromInterval(minutes: number | null): string {
  if (minutes === 15) return "*/15 * * * *";
  if (minutes === 60) return "0 * * * *";
  if (minutes === 1440) return "0 0 * * *";
  return "";
}

function nextNodeNumber(nodes: readonly WorkflowNodeDraft[]): number {
  const used = new Set(
    nodes
      .map((node) => /^node-(\d+)$/u.exec(node.id)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number),
  );
  let next = 1;
  while (used.has(next)) next += 1;
  return next;
}
