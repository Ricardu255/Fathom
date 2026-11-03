import { BoardTaskStatus, type BoardTaskView } from "@harness/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  CirclePlay,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../../api/client";
import { boardTasksQueryOptions, boardWorkspacesQueryOptions, queryKeys } from "../../api/queries";
import type { BoardTaskWorkspace } from "../../api/types";

const COLUMNS: readonly {
  color: string;
  label: string;
  status: BoardTaskStatus;
}[] = [
  { color: "var(--muted-2)", label: "待开始", status: BoardTaskStatus.PENDING },
  { color: "var(--accent)", label: "执行中", status: BoardTaskStatus.IN_PROGRESS },
  { color: "var(--amber)", label: "需处理", status: BoardTaskStatus.WAITING },
  {
    color: "color-mix(in oklch, var(--accent) 65%, var(--red))",
    label: "待确认",
    status: BoardTaskStatus.CONFIRMATION,
  },
  { color: "var(--green)", label: "已完成", status: BoardTaskStatus.COMPLETED },
];

const STATUS_LABEL: Record<BoardTaskStatus, string> = {
  [BoardTaskStatus.COMPLETED]: "已完成",
  [BoardTaskStatus.CONFIRMATION]: "待确认",
  [BoardTaskStatus.IN_PROGRESS]: "执行中",
  [BoardTaskStatus.PENDING]: "待开始",
  [BoardTaskStatus.WAITING]: "需处理",
};

interface EditorState {
  mode: "create" | "edit";
  task: BoardTaskView | null;
}

export function BoardPage() {
  const queryClient = useQueryClient();
  const tasksQuery = useQuery(boardTasksQueryOptions());
  const workspacesQuery = useQuery(boardWorkspacesQueryOptions());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const tasks = tasksQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const selected = tasks.find((task) => task.id === selectedId) ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.boardTasks });
  };

  const createMutation = useMutation({
    mutationFn: (input: { objective: string; title: string; workspaceRoot?: string }) =>
      apiFetch<BoardTaskView>("/api/board/tasks", {
        body: JSON.stringify(input),
        method: "POST",
      }),
    onSuccess: async (task) => {
      setEditor(null);
      setSelectedId(task.id);
      await invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; objective: string; title: string }) =>
      apiFetch<BoardTaskView>(`/api/board/tasks/${encodeURIComponent(input.id)}`, {
        body: JSON.stringify({ objective: input.objective, title: input.title }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      setEditor(null);
      await invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/board/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      if (selectedId === id) setSelectedId(null);
      await invalidate();
    },
  });

  const startMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ runId: string; sessionId: string; task: BoardTaskView }>(
        `/api/board/tasks/${encodeURIComponent(id)}/start`,
        { method: "POST" },
      ),
    onSuccess: async (result) => {
      setActionError(null);
      setSelectedId(result.task.id);
      await invalidate();
    },
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<BoardTaskView>(`/api/board/tasks/${encodeURIComponent(id)}/confirm`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });

  const runAction = (action: () => void) => {
    setActionError(null);
    action();
  };

  const isLoading = tasksQuery.isPending || workspacesQuery.isPending;

  return (
    <div className="tasks-page">
      <header className="tasks-header">
        <div>
          <h1>任务看板</h1>
          <p>创建目标，启动一个 Run，并在审批、待确认与完成之间跟踪任务。</p>
        </div>
        <div className="tasks-header-actions">
          <button
            className="btn btn-ghost"
            disabled={tasksQuery.isFetching}
            onClick={() => void tasksQuery.refetch()}
            type="button"
          >
            <RefreshCw className={tasksQuery.isFetching ? "spin" : undefined} size={15} /> 刷新
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setEditor({ mode: "create", task: null })}
            type="button"
          >
            <Plus size={15} /> 新建任务
          </button>
        </div>
      </header>

      {tasksQuery.error !== null ? (
        <div className="inline-error">加载任务失败：{tasksQuery.error.message}</div>
      ) : null}
      {actionError !== null ? <div className="inline-error">{actionError}</div> : null}

      {isLoading ? (
        <div className="page-loading">加载任务…</div>
      ) : (
        <div className="tasks-board">
          {COLUMNS.map((column) => {
            const items = tasks.filter((task) => task.status === column.status);
            return (
              <section className="tasks-column" key={column.status}>
                <div className="tasks-column-head">
                  <span
                    className="tasks-column-indicator"
                    style={{ backgroundColor: column.color }}
                  />
                  <span>{column.label}</span>
                  <span className="tasks-column-count">{items.length}</span>
                </div>
                <div className="tasks-column-body">
                  {items.length === 0 ? (
                    <div className="tasks-column-empty">暂无任务</div>
                  ) : (
                    items.map((task) => (
                      <TaskCard key={task.id} onSelect={() => setSelectedId(task.id)} task={task} />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editor !== null ? (
        <TaskEditorDialog
          key={`${editor.mode}-${editor.task?.id ?? "new"}`}
          mode={editor.mode}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            try {
              setActionError(null);
              if (editor.mode === "create") {
                await createMutation.mutateAsync(input);
              } else if (editor.task !== null) {
                await updateMutation.mutateAsync({ id: editor.task.id, ...input });
              }
            } catch (error: unknown) {
              setActionError(error instanceof Error ? error.message : "保存任务失败");
              throw error;
            }
          }}
          pending={createMutation.isPending || updateMutation.isPending}
          task={editor.task}
          workspaces={workspaces}
        />
      ) : null}

      {selected !== null ? (
        <TaskDetailDialog
          onClose={() => setSelectedId(null)}
          onConfirm={() =>
            runAction(() => {
              confirmMutation.mutate(selected.id, {
                onError: (error: unknown) =>
                  setActionError(error instanceof Error ? error.message : "确认任务失败"),
              });
            })
          }
          onDelete={() => {
            if (!window.confirm(`删除任务“${selected.title}”？`)) return;
            runAction(() => {
              deleteMutation.mutate(selected.id, {
                onError: (error: unknown) =>
                  setActionError(error instanceof Error ? error.message : "删除任务失败"),
              });
            });
          }}
          onEdit={() => setEditor({ mode: "edit", task: selected })}
          onStart={() =>
            runAction(() => {
              startMutation.mutate(selected.id, {
                onError: (error: unknown) =>
                  setActionError(error instanceof Error ? error.message : "启动任务失败"),
              });
            })
          }
          pending={startMutation.isPending || confirmMutation.isPending || deleteMutation.isPending}
          task={selected}
        />
      ) : null}
    </div>
  );
}

function TaskCard({ onSelect, task }: { onSelect: () => void; task: BoardTaskView }) {
  return (
    <button className={`task-card task-${task.status}`} onClick={onSelect} type="button">
      <span className={`task-title${task.status === "completed" ? " completed" : ""}`}>
        {task.title}
      </span>
      <span className="task-workspace">{task.workspaceName}</span>
      {task.attentionReason !== null ? (
        <span className="task-attention">{task.attentionReason}</span>
      ) : task.currentStep !== null ? (
        <span className="task-step">{task.currentStep}</span>
      ) : null}
      {task.progress !== null && task.progress.total > 0 ? (
        <span className="task-progress">
          <span className="task-progress-meta">
            <span>进度</span>
            <span>
              {task.progress.completed}/{task.progress.total}
            </span>
          </span>
          <span className="task-progress-track">
            <span
              style={{
                width: `${Math.round((task.progress.completed / task.progress.total) * 100)}%`,
              }}
            />
          </span>
        </span>
      ) : null}
      <span className="task-footer">
        <span className="task-files">
          {task.fileChangeCount > 0 ? (
            <>
              <FileText size={11} /> {task.fileChangeCount} 个文件
            </>
          ) : null}
        </span>
        <span>{formatRelativeTime(task.updatedAt)}</span>
      </span>
    </button>
  );
}

function TaskEditorDialog({
  mode,
  onClose,
  onSave,
  pending,
  task,
  workspaces,
}: {
  mode: "create" | "edit";
  onClose: () => void;
  onSave: (input: { objective: string; title: string; workspaceRoot?: string }) => Promise<void>;
  pending: boolean;
  task: BoardTaskView | null;
  workspaces: readonly BoardTaskWorkspace[];
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [objective, setObjective] = useState(task?.objective ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState(
    task?.workspaceRoot ?? workspaces[0]?.root ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    if (title.trim() === "" || objective.trim() === "") {
      setError("请填写标题和任务目标");
      return;
    }
    setError(null);
    try {
      await onSave({
        objective: objective.trim(),
        title: title.trim(),
        ...(workspaceRoot === "" ? {} : { workspaceRoot }),
      });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "保存任务失败");
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="task-editor-title"
        aria-modal="true"
        className="dialog-panel"
        role="dialog"
      >
        <div className="dialog-head">
          <h2 id="task-editor-title">{mode === "create" ? "新建任务" : "编辑任务"}</h2>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <label className="field">
            <span>标题</span>
            <input
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：修复登录页的会话恢复"
              value={title}
            />
          </label>
          <label className="field">
            <span>任务目标与验收要求</span>
            <textarea
              maxLength={20_000}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="描述要完成什么、如何验收、需要注意的边界。"
              rows={6}
              value={objective}
            />
          </label>
          {mode === "create" ? (
            <label className="field">
              <span>工作区</span>
              <select
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                value={workspaceRoot}
              >
                {workspaces.length === 0 ? <option value="">默认工作区</option> : null}
                {workspaces.map((workspace) => (
                  <option key={workspace.root} value={workspace.root}>
                    {workspace.name} · {workspace.root}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error !== null ? <div className="inline-error">{error}</div> : null}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose} type="button">
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={pending}
            onClick={() => void submit()}
            type="button"
          >
            {pending ? <Loader2 className="spin" size={15} /> : null}
            {mode === "create" ? "创建任务" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskDetailDialog({
  onClose,
  onConfirm,
  onDelete,
  onEdit,
  onStart,
  pending,
  task,
}: {
  onClose: () => void;
  onConfirm: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onStart: () => void;
  pending: boolean;
  task: BoardTaskView;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const canStart =
    task.status === BoardTaskStatus.PENDING || task.status === BoardTaskStatus.WAITING;
  const editable =
    task.status === BoardTaskStatus.PENDING || task.status === BoardTaskStatus.WAITING;

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="task-detail-title"
        aria-modal="true"
        className="dialog-panel dialog-wide"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="task-detail-title">{task.title}</h2>
            <div className="task-detail-sub">
              <span className="task-workspace">{task.workspaceName}</span>
              <span className={`task-status task-status-${task.status}`}>
                {STATUS_LABEL[task.status]}
              </span>
            </div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <section className="task-section">
            <h3>目标与验收要求</h3>
            <p className="task-objective">{task.objective}</p>
          </section>
          {task.currentStep !== null ? (
            <section className="task-section">
              <h3>当前步骤</h3>
              <p>{task.currentStep}</p>
              {task.progress !== null && task.progress.total > 0 ? (
                <div className="task-progress-track large">
                  <span
                    style={{
                      width: `${Math.round((task.progress.completed / task.progress.total) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
            </section>
          ) : null}
          {task.attentionReason !== null ? (
            <section className="task-attention-box">
              <strong>需要你处理</strong>
              <p>{task.attentionReason}</p>
            </section>
          ) : null}
          <div className="task-detail-meta">
            <span>
              <CalendarClock size={13} /> 创建 {formatRelativeTime(task.createdAt)}
            </span>
            {task.fileChangeCount > 0 ? (
              <span>
                <FileText size={13} /> {task.fileChangeCount} 个文件变更
              </span>
            ) : null}
            {task.sessionId !== null ? (
              <Link className="btn btn-ghost" to={`/s/${task.sessionId}`}>
                <Bot size={14} /> 打开对话
              </Link>
            ) : null}
          </div>
        </div>
        <div className="dialog-actions">
          <button
            className="btn btn-ghost danger"
            disabled={pending || task.status === BoardTaskStatus.IN_PROGRESS}
            onClick={onDelete}
            type="button"
          >
            <Trash2 size={14} /> 删除
          </button>
          <span className="dialog-spacer" />
          {editable ? (
            <button className="btn btn-ghost" disabled={pending} onClick={onEdit} type="button">
              <Pencil size={14} /> 编辑
            </button>
          ) : null}
          {task.status === BoardTaskStatus.CONFIRMATION ? (
            <button
              className="btn btn-primary"
              disabled={pending}
              onClick={onConfirm}
              type="button"
            >
              <CheckCircle2 size={14} /> 确认完成
            </button>
          ) : null}
          {canStart ? (
            <button className="btn btn-primary" disabled={pending} onClick={onStart} type="button">
              <CirclePlay size={14} />{" "}
              {task.status === BoardTaskStatus.WAITING ? "重试" : "开始执行"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
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
