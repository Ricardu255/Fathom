import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitFork,
  LayoutGrid,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import {
  archivedSessionsQueryOptions,
  queryKeys,
  sessionsQueryOptions,
  settingsQueryOptions,
  workspacesQueryOptions,
} from "../api/queries";
import type { Session, Workspace } from "../api/types";
import { useAddWorkspace } from "../features/workspaces/use-add-workspace";
import { BranchTreeDialog } from "./BranchTreeDialog";
import { openCommandPalette } from "./CommandPalette";

const SESSION_PAGE_SIZE = 5;

export function Sidebar() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sessionsQuery = useQuery(sessionsQueryOptions());
  const workspacesQuery = useQuery(workspacesQueryOptions());
  const settingsQuery = useQuery(settingsQueryOptions());
  const addWorkspace = useAddWorkspace();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(
        window.localStorage.getItem("fathom-collapsed-workspaces") ?? "[]",
      ) as unknown;
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const archivedQuery = useQuery({ ...archivedSessionsQueryOptions(), enabled: showArchived });

  useEffect(() => {
    window.localStorage.setItem(
      "fathom-collapsed-workspaces",
      JSON.stringify([...collapsedWorkspaces]),
    );
  }, [collapsedWorkspaces]);

  const refreshSessionLists = async (sessionId?: string) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    await queryClient.invalidateQueries({ queryKey: queryKeys.archivedSessions });
    if (sessionId !== undefined) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
    }
  };

  const archiveMutation = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
    onSuccess: async (_result, sessionId) => {
      await refreshSessionLists(sessionId);
      if (window.location.pathname === `/s/${sessionId}`) navigate("/");
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
        method: "POST",
      }),
    onSuccess: async (_result, sessionId) => {
      await refreshSessionLists(sessionId);
    },
  });

  const forkMutation = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: "POST",
      }),
    onSuccess: async (session) => {
      await refreshSessionLists(session.id);
      navigate(`/s/${session.id}`);
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { sessionId: string; title: string }) =>
      apiFetch<Session>(`/api/sessions/${encodeURIComponent(input.sessionId)}`, {
        body: JSON.stringify({ title: input.title }),
        method: "PATCH",
      }),
    onSuccess: async (_result, input) => {
      setEditingId(null);
      await refreshSessionLists(input.sessionId);
    },
  });

  const renameWorkspaceMutation = useMutation({
    mutationFn: (input: { displayName: string; workspaceId: string }) =>
      apiFetch<Workspace>(`/api/workspaces/${encodeURIComponent(input.workspaceId)}`, {
        body: JSON.stringify({ displayName: input.displayName }),
        method: "PATCH",
      }),
    onSuccess: async () => {
      setEditingWorkspaceId(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });

  const removeWorkspaceMutation = useMutation({
    mutationFn: (workspaceId: string) =>
      apiFetch<void>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
      }),
    onSuccess: async (_result, workspaceId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      await refreshSessionLists();
      const currentSessionId = window.location.pathname.startsWith("/s/")
        ? window.location.pathname.slice(3)
        : null;
      const currentSession = sessions.find((session) => session.id === currentSessionId);
      if (currentSession?.workspaceId === workspaceId) navigate("/");
    },
  });

  const reorderWorkspacesMutation = useMutation({
    mutationFn: (ids: readonly string[]) =>
      apiFetch<Workspace[]>("/api/workspaces/order", {
        body: JSON.stringify({ ids }),
        method: "PUT",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });

  const sessions = sessionsQuery.data ?? [];
  const allWorkspaces = workspacesQuery.data ?? [];
  const workspaces = allWorkspaces.filter((workspace) => workspace.removedAt === null);
  const archived = (archivedQuery.data ?? []).filter((session) => session.archivedAt !== null);
  const knownWorkspaceIds = new Set(allWorkspaces.map((workspace) => workspace.id));
  const orphanSessions = sessions.filter(
    (session) =>
      session.workspaceId === null ||
      (session.workspaceId !== null && !knownWorkspaceIds.has(session.workspaceId)),
  );

  const submitRename = (sessionId: string) => {
    const title = draftTitle.trim();
    if (title === "") {
      setEditingId(null);
      return;
    }
    renameMutation.mutate({ sessionId, title });
  };

  const submitWorkspaceRename = (workspaceId: string) => {
    const displayName = workspaceDraft.trim();
    if (displayName === "") {
      setEditingWorkspaceId(null);
      return;
    }
    renameWorkspaceMutation.mutate({ displayName, workspaceId });
  };

  const handleAddWorkspace = async () => {
    setWorkspaceError(null);
    setAddingWorkspace(true);
    try {
      const workspace = await addWorkspace();
      if (workspace !== null) navigate(`/?workspace=${encodeURIComponent(workspace.id)}`);
    } catch (cause: unknown) {
      setWorkspaceError(cause instanceof Error ? cause.message : "添加工作区失败");
    } finally {
      setAddingWorkspace(false);
    }
  };

  const toggleWorkspace = (workspaceId: string) => {
    setCollapsedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const reorderWorkspace = (targetId: string) => {
    if (draggedWorkspaceId === null || draggedWorkspaceId === targetId) return;
    const ids = workspaces.map((workspace) => workspace.id);
    const withoutDragged = ids.filter((id) => id !== draggedWorkspaceId);
    const targetIndex = withoutDragged.indexOf(targetId);
    if (targetIndex < 0) return;
    withoutDragged.splice(targetIndex, 0, draggedWorkspaceId);
    reorderWorkspacesMutation.mutate(withoutDragged);
  };

  const moveWorkspace = (workspaceId: string, direction: -1 | 1) => {
    const ids = workspaces.map((workspace) => workspace.id);
    const index = ids.indexOf(workspaceId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    reorderWorkspacesMutation.mutate(ids);
  };

  const renderSessionRow = (session: Session) => (
    <div className="session-row" key={session.id}>
      {editingId === session.id ? (
        <form
          className="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            submitRename(session.id);
          }}
        >
          <input
            aria-label="会话标题"
            maxLength={120}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(null);
            }}
            value={draftTitle}
          />
          <button aria-label="保存标题" className="session-action" type="submit">
            <Check size={13} />
          </button>
          <button
            aria-label="取消重命名"
            className="session-action"
            onClick={() => setEditingId(null)}
            type="button"
          >
            <X size={13} />
          </button>
        </form>
      ) : (
        <>
          <NavLink
            className={({ isActive }) => `session-link${isActive ? " active" : ""}`}
            to={`/s/${session.id}`}
            title={session.workspaceRoot}
          >
            <span className="session-title">
              {session.isRunning === true ? <Loader2 className="spin" size={11} /> : null}
              <span>{session.title}</span>
            </span>
            <span className="session-meta">
              {session.parentSessionId === null ? "" : "分支 · "}
              {new Date(session.updatedAt).toLocaleDateString()} · {session.lastSeq} 事件
            </span>
          </NavLink>
          <div className="session-actions">
            <button
              aria-label="重命名对话"
              className="session-action"
              onClick={() => {
                setEditingId(session.id);
                setDraftTitle(session.title);
              }}
              type="button"
            >
              <Pencil size={13} />
            </button>
            <button
              aria-label="创建会话分支"
              className="session-action"
              disabled={forkMutation.isPending}
              onClick={() => forkMutation.mutate(session.id)}
              type="button"
            >
              <GitBranch size={13} />
            </button>
            <button
              aria-label="归档对话"
              className="session-action"
              onClick={() => {
                if (window.confirm(`归档“${session.title}”？`)) {
                  archiveMutation.mutate(session.id);
                }
              }}
              type="button"
            >
              <Archive size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );

  const renderSessionList = (workspaceId: string, groupSessions: Session[]) => {
    if (groupSessions.length === 0) return <div className="sidebar-empty">暂无对话</div>;
    const visibleCount = visibleCounts[workspaceId] ?? SESSION_PAGE_SIZE;
    return (
      <>
        {groupSessions.slice(0, visibleCount).map(renderSessionRow)}
        {groupSessions.length > SESSION_PAGE_SIZE ? (
          <button
            className="section-action workspace-show-more"
            onClick={() =>
              setVisibleCounts((current) => ({
                ...current,
                [workspaceId]:
                  visibleCount >= groupSessions.length ? SESSION_PAGE_SIZE : visibleCount + 5,
              }))
            }
            type="button"
          >
            {visibleCount >= groupSessions.length ? "收起" : "显示更多"}
          </button>
        ) : null}
      </>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg aria-hidden="true" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16.5" />
            <circle className="thin" cx="20" cy="20" r="13" />
            <path d="M20 8.5c3.6 4.2 5.4 8 5.4 11.5 0 4.2-2.4 7.4-5.4 9.5-3-2.1-5.4-5.3-5.4-9.5 0-3.5 1.8-7.3 5.4-11.5Z" />
            <path className="thin" d="M20 15.5v9.5" />
            <circle className="dot" cx="20" cy="27.4" r="1" />
          </svg>
        </div>
        <div>
          <div className="brand-name">Fathom</div>
          <div className="brand-sub">L'atelier local</div>
        </div>
      </div>

      <button className="new-chat" onClick={() => navigate("/")} type="button">
        <MessageSquarePlus size={16} />
        新建对话
      </button>

      <button className="sidebar-search" onClick={openCommandPalette} type="button">
        <Search size={15} />
        <span>搜索对话或命令</span>
        <kbd>⌘K</kbd>
      </button>

      <nav className="nav">
        <NavLink className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} to="/board">
          <LayoutGrid size={16} />
          任务看板
        </NavLink>
        <NavLink
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
          to="/literature"
        >
          <BookOpen size={16} />
          文献解析
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} to="/memory">
          <Brain size={16} />
          长期记忆
        </NavLink>
        <NavLink
          className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
          to="/workflows"
        >
          <GitFork size={16} />
          工作流
        </NavLink>
        <NavLink className={({ isActive }) => `nav-link${isActive ? " active" : ""}`} to="/usage">
          <BarChart3 size={16} />
          用量统计
        </NavLink>
      </nav>

      <div className="section-label session-section-label">
        <span>工作区</span>
        <div className="section-actions">
          <button
            className="section-action"
            disabled={addingWorkspace}
            onClick={() => void handleAddWorkspace()}
            type="button"
          >
            {addingWorkspace ? "添加中…" : "添加"}
          </button>
          <button className="section-action" onClick={() => setShowBranches(true)} type="button">
            分支树
          </button>
          <button className="section-action" onClick={() => setShowArchived(true)} type="button">
            已归档
          </button>
        </div>
      </div>

      {workspaceError !== null ? <div className="sidebar-empty">{workspaceError}</div> : null}

      <div className="session-list workspace-list">
        {workspacesQuery.isPending || sessionsQuery.isPending ? (
          <div className="sidebar-empty">加载中…</div>
        ) : workspaces.length === 0 ? (
          <div className="sidebar-empty">还没有工作区</div>
        ) : (
          workspaces.map((workspace) => {
            const groupSessions = sessions.filter(
              (session) =>
                session.workspaceId === workspace.id ||
                (session.workspaceId === null && session.workspaceRoot === workspace.rootPath),
            );
            const collapsed = collapsedWorkspaces.has(workspace.id);
            return (
              <section className="workspace-group" key={workspace.id}>
                <fieldset
                  className={`workspace-header${
                    draggedWorkspaceId === workspace.id ? " dragging" : ""
                  }${workspace.isAvailable ? "" : " unavailable"}`}
                  draggable
                  onDragEnd={() => setDraggedWorkspaceId(null)}
                  onDragOver={(event) => {
                    if (draggedWorkspaceId !== null && draggedWorkspaceId !== workspace.id) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDragStart={(event) => {
                    setDraggedWorkspaceId(workspace.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", workspace.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    reorderWorkspace(workspace.id);
                    setDraggedWorkspaceId(null);
                  }}
                >
                  <legend className="sr-only">{workspace.displayName} 工作区</legend>
                  <button
                    aria-label={collapsed ? "展开工作区" : "收起工作区"}
                    className="workspace-toggle"
                    onClick={() => toggleWorkspace(workspace.id)}
                    type="button"
                  >
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  </button>
                  <button
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    className="workspace-name"
                    onClick={() => toggleWorkspace(workspace.id)}
                    onKeyDown={(event) => {
                      if (!event.altKey) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveWorkspace(workspace.id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveWorkspace(workspace.id, 1);
                      }
                    }}
                    title={workspace.rootPath}
                    type="button"
                  >
                    <FolderOpen size={14} />
                    <span>{workspace.displayName}</span>
                  </button>
                  <span className="workspace-count">{groupSessions.length}</span>
                  <div className="workspace-actions">
                    <button
                      aria-label={`在 ${workspace.displayName} 中新建对话`}
                      className="session-action"
                      disabled={!workspace.isAvailable}
                      onClick={() => navigate(`/?workspace=${encodeURIComponent(workspace.id)}`)}
                      title={workspace.isAvailable ? undefined : "目录不存在或无法访问"}
                      type="button"
                    >
                      <Plus size={13} />
                    </button>
                    <button
                      aria-label="重命名工作区"
                      className="session-action"
                      onClick={() => {
                        setEditingWorkspaceId(workspace.id);
                        setWorkspaceDraft(workspace.displayName);
                      }}
                      type="button"
                    >
                      <Pencil size={13} />
                    </button>
                    {window.fathom?.workspace?.reveal !== undefined ? (
                      <button
                        aria-label={`在文件管理器中显示 ${workspace.displayName}`}
                        className="session-action"
                        onClick={() => void window.fathom?.workspace?.reveal(workspace.rootPath)}
                        type="button"
                      >
                        <ExternalLink size={13} />
                      </button>
                    ) : null}
                    <button
                      aria-label="移除工作区"
                      className="session-action"
                      onClick={() => {
                        if (
                          window.confirm(
                            `移除“${workspace.displayName}”？对话与本地文件不会被删除。`,
                          )
                        ) {
                          removeWorkspaceMutation.mutate(workspace.id);
                        }
                      }}
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </fieldset>

                {editingWorkspaceId === workspace.id ? (
                  <form
                    className="session-rename workspace-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitWorkspaceRename(workspace.id);
                    }}
                  >
                    <input
                      aria-label="工作区名称"
                      maxLength={120}
                      onChange={(event) => setWorkspaceDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingWorkspaceId(null);
                      }}
                      value={workspaceDraft}
                    />
                    <button aria-label="保存工作区名称" className="session-action" type="submit">
                      <Check size={13} />
                    </button>
                    <button
                      aria-label="取消重命名"
                      className="session-action"
                      onClick={() => setEditingWorkspaceId(null)}
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  </form>
                ) : null}

                {!collapsed ? (
                  <div className="workspace-sessions">
                    {renderSessionList(workspace.id, groupSessions)}
                  </div>
                ) : null}
              </section>
            );
          })
        )}

        {orphanSessions.length > 0 ? (
          <section className="workspace-group">
            <div className="workspace-header">
              <span className="workspace-toggle" />
              <span className="workspace-name orphan">
                <FolderOpen size={14} />
                未分组
              </span>
              <span className="workspace-count">{orphanSessions.length}</span>
            </div>
            <div className="workspace-sessions">
              {renderSessionList("__orphan", orphanSessions)}
            </div>
          </section>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <NavLink
          className={({ isActive }) => `sidebar-settings-link${isActive ? " active" : ""}`}
          to="/settings"
        >
          <Settings2 size={15} />
          <span className="sidebar-settings-label">设置</span>
          <span className="sidebar-settings-model" title={settingsQuery.data?.model ?? ""}>
            <Bot size={13} />
            {settingsQuery.data?.apiKeyConfigured === false
              ? "未配置模型"
              : (settingsQuery.data?.model ?? "加载中")}
          </span>
        </NavLink>
      </div>

      {showBranches ? (
        <BranchTreeDialog
          currentSessionId={
            window.location.pathname.startsWith("/s/") ? window.location.pathname.slice(3) : null
          }
          onClose={() => setShowBranches(false)}
          sessions={sessions}
        />
      ) : null}

      {showArchived ? (
        <div className="dialog-backdrop">
          <div
            aria-labelledby="archived-sessions-title"
            aria-modal="true"
            className="dialog-panel"
            role="dialog"
          >
            <div className="dialog-head">
              <h2 id="archived-sessions-title">已归档对话</h2>
              <button
                aria-label="关闭"
                className="dialog-close"
                onClick={() => setShowArchived(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="dialog-body">
              {archivedQuery.isPending ? (
                <p className="muted-text">加载中…</p>
              ) : archived.length === 0 ? (
                <p className="muted-text">没有已归档的对话。</p>
              ) : (
                <div className="archived-list">
                  {archived.map((session) => (
                    <div className="archived-row" key={session.id}>
                      <div>
                        <div className="archived-title">{session.title}</div>
                        <div className="archived-meta">
                          归档于{" "}
                          {new Date(session.archivedAt ?? session.updatedAt).toLocaleString()}
                        </div>
                      </div>
                      <button
                        className="btn btn-ghost"
                        disabled={restoreMutation.isPending}
                        onClick={() => restoreMutation.mutate(session.id)}
                        type="button"
                      >
                        <Undo2 size={14} /> 恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button
                className="btn btn-ghost"
                onClick={() => setShowArchived(false)}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
