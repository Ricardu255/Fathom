import { type AgentMessage, messageImages, type UserInputAnswer } from "@harness/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Copy,
  FolderTree,
  GitBranch,
  GitCompare,
  GitPullRequest,
  History,
  Loader2,
  LocateFixed,
  Paperclip,
  Pencil,
  RotateCcw,
  Shrink,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, apiFetch } from "../../api/client";
import {
  modelCatalogQueryOptions,
  queryKeys,
  sessionSnapshotQueryOptions,
  sessionsQueryOptions,
} from "../../api/queries";
import type { ChatImage, Session, ThinkingLevel } from "../../api/types";
import { ApprovalCard } from "../../components/ApprovalCard";
import { ApprovalPicker } from "../../components/ApprovalPicker";
import { BackgroundCommandDrawer } from "../../components/BackgroundCommandDrawer";
import { BranchCompareDialog } from "../../components/BranchCompareDialog";
import { CheckpointDialog } from "../../components/CheckpointDialog";
import { Composer } from "../../components/Composer";
import { ContextUsagePopover } from "../../components/ContextUsagePopover";
import { FileChangePanel } from "../../components/FileChangePanel";
import { GitDrawer } from "../../components/GitDrawer";
import { Markdown } from "../../components/Markdown";
import { ModelPicker, type ModelSelection } from "../../components/ModelPicker";
import { QueueChips } from "../../components/QueueChips";
import { RewriteDialog } from "../../components/RewriteDialog";
import { SubAgentBoard } from "../../components/SubAgentBoard";
import { ToolCard } from "../../components/ToolCard";
import { UserInputCard } from "../../components/UserInputCard";
import { WorkCapsule } from "../../components/WorkCapsule";
import { WorkspaceBrowser } from "../../components/WorkspaceBrowser";
import { WorkspaceDrawer } from "../../components/WorkspaceDrawer";
import { useChatStore } from "../../stores/chat-store";
import { TraceView } from "../trace/TracePage";
import { isNearBottom } from "./follow-bottom";
import { useSessionStream } from "./use-session-stream";

function messageText(message: AgentMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function messageThinking(message: AgentMessage): string {
  return message.content
    .flatMap((block) => (block.type === "thinking" ? [block.text] : []))
    .join("\n")
    .trim();
}

export function ChatPage({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const snapshotQuery = useQuery(sessionSnapshotQueryOptions(sessionId));
  const hydratedSession = useRef<string | null>(null);

  const messages = useChatStore((state) => state.messages);
  const streamingText = useChatStore((state) => state.streamingText);
  const reasoningText = useChatStore((state) => state.reasoningText);
  const tools = useChatStore((state) => state.tools);
  const approvals = useChatStore((state) => state.approvals);
  const isRunning = useChatStore((state) => state.isRunning);
  const runId = useChatStore((state) => state.runId);
  const error = useChatStore((state) => state.error);
  const todos = useChatStore((state) => state.todos);
  const fileChanges = useChatStore((state) => state.fileChanges);
  const queued = useChatStore((state) => state.queued);
  const attachmentContext = useChatStore((state) => state.attachmentContext);
  const plan = useChatStore((state) => state.plan);
  const isCompacting = useChatStore((state) => state.isCompacting);
  const lastUsage = useChatStore((state) => state.lastUsage);
  const userInputs = useChatStore((state) => state.userInputs);
  const compactionCount = useChatStore((state) => state.compactionCount);
  const retryNotice = useChatStore((state) => state.retryNotice);
  const subAgents = useChatStore((state) => state.subAgents);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<number, HTMLElement>());
  const [activeTurn, setActiveTurn] = useState(0);
  const [view, setView] = useState<"chat" | "files" | "trace">("chat");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadTurns, setUnreadTurns] = useState(0);
  const previousMessageCount = useRef(messages.length);
  const visibleMessages = messages.filter(
    (message) => messageText(message) !== "" || messageImages(message).length > 0,
  );
  const renderedMessages = visibleMessages.slice(-visibleLimit);
  const turns = useMemo(
    () =>
      messages
        .filter(
          (message) =>
            message.role === "user" &&
            (messageText(message) !== "" || messageImages(message).length > 0),
        )
        .map((message) => ({
          preview: messageText(message).replace(/\s+/gu, " ").slice(0, 32),
          timestamp: message.timestamp,
        })),
    [messages],
  );
  const wasRunning = useRef(isRunning);
  const [forking, setForking] = useState<number | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [planRevision, setPlanRevision] = useState("");
  const [revisingPlan, setRevisingPlan] = useState(false);
  const [rewriteTarget, setRewriteTarget] = useState<{ text: string; timestamp: number } | null>(
    null,
  );
  const [fileChangeBusy, setFileChangeBusy] = useState<"replay" | "undo" | null>(null);
  const [fileChangeNotice, setFileChangeNotice] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const sessionsQuery = useQuery(sessionsQueryOptions());
  const catalogQuery = useQuery(modelCatalogQueryOptions());

  useEffect(() => {
    const snapshot = snapshotQuery.data;
    if (snapshot !== undefined && hydratedSession.current !== sessionId) {
      useChatStore.getState().hydrate(sessionId, snapshot);
      hydratedSession.current = sessionId;
    }
  }, [sessionId, snapshotQuery.data]);

  useSessionStream(sessionId, snapshotQuery.isSuccess);

  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    }
    wasRunning.current = isRunning;
  }, [isRunning, queryClient]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值变化时需要把视口滚到底部
  useEffect(() => {
    if (!followingOutput) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streamingText, tools.length, approvals, error, followingOutput]);

  // 用户往回翻的时候只累计新消息数，不抢滚动位置。
  useEffect(() => {
    const grew = messages.length > previousMessageCount.current;
    previousMessageCount.current = messages.length;
    if (!grew || followingOutput) return;
    setUnreadTurns((count) => count + 1);
  }, [messages.length, followingOutput]);

  const send = async (
    text: string,
    images: readonly ChatImage[] = [],
    attachments: readonly string[] = [],
    mode = planMode,
  ) => {
    try {
      const result = await apiFetch<{ queuedInputId?: string; runId?: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          body: JSON.stringify({ attachments, images, planMode: mode, text }),
          method: "POST",
        },
      );
      if (result.queuedInputId !== undefined) {
        useChatStore.getState().addQueued({
          createdAt: Date.now(),
          id: result.queuedInputId,
          text: text.trim(),
        });
      } else {
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "消息发送失败");
      throw cause;
    }
  };

  const steer = async (text: string, images: readonly ChatImage[] = []) => {
    try {
      await apiFetch<{ disposition: "handled" | "queued" }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
        { body: JSON.stringify({ images, planMode, text }), method: "POST" },
      );
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "插话失败");
      throw cause;
    }
  };

  const changeModel = async (selection: ModelSelection) => {
    try {
      await apiFetch<Session>(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
        body: JSON.stringify(selection),
        method: "PATCH",
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "切换模型失败");
    }
  };

  const approvePlan = async () => {
    setPlanMode(false);
    await send("请按以上计划开始执行。", [], [], false);
  };

  const revisePlan = async () => {
    const feedback = planRevision.trim();
    if (feedback === "" || revisingPlan) return;
    setRevisingPlan(true);
    try {
      await send(
        `请基于上一版计划，按以下反馈修改，只输出完整的下一版计划，不要执行：\n\n${feedback}`,
        [],
        [],
        true,
      );
      setPlanRevision("");
    } finally {
      setRevisingPlan(false);
    }
  };

  const jumpToContext = (timestamp: number) => {
    const turn = [...turns].reverse().find((item) => item.timestamp <= timestamp) ?? turns[0];
    if (turn === undefined) return;
    const element = messageRefs.current.get(turn.timestamp);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlighted(turn.timestamp);
    window.setTimeout(() => setHighlighted(null), 1_800);
  };

  const copyMessage = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      useChatStore.getState().setError("复制失败，请手动选择文本");
    }
  };

  const retryFromMessage = async (timestamp: number, text: string) => {
    if (isRunning || retrying !== null) return;
    setRetrying(timestamp);
    try {
      const result = await apiFetch<{ session: Session }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/rewrite`,
        {
          body: JSON.stringify({ fromTimestamp: timestamp, text }),
          method: "POST",
        },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      navigate(`/s/${result.session.id}`);
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "重试消息失败");
    } finally {
      setRetrying(null);
    }
  };

  const forkFromMessage = async (timestamp: number) => {
    setForking(timestamp);
    try {
      const session = await apiFetch<Session>(
        `/api/sessions/${encodeURIComponent(sessionId)}/fork?fromTimestamp=${timestamp}`,
        { method: "POST" },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      navigate(`/s/${session.id}`);
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "创建分支失败");
    } finally {
      setForking(null);
    }
  };

  const removeQueued = async (inputId: string) => {
    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/queued/${encodeURIComponent(inputId)}`,
        { method: "DELETE" },
      );
      useChatStore.getState().removeQueuedLocal(inputId);
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "移除排队消息失败");
    }
  };

  const applyFileChanges = async (action: "replay" | "undo") => {
    const paths = [...new Set(fileChanges.map((change) => change.path))];
    if (paths.length === 0) return;
    setFileChangeBusy(action);
    setFileChangeNotice(null);
    try {
      const result = await apiFetch<{ action: string; paths: string[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/file-changes/${action}`,
        { body: JSON.stringify({ paths }), method: "POST" },
      );
      setFileChangeNotice(
        `${action === "undo" ? "已撤销" : "已重放"} ${result.paths.length} 个文件的变更。`,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    } catch (cause: unknown) {
      useChatStore
        .getState()
        .setError(
          cause instanceof Error
            ? cause.message
            : action === "undo"
              ? "撤销文件变更失败"
              : "重放文件变更失败",
        );
    } finally {
      setFileChangeBusy(null);
    }
  };

  const resumeSession = async () => {
    try {
      await apiFetch<{ runId?: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
        method: "POST",
      });
      useChatStore.getState().dismissError();
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "续跑失败");
    }
  };

  const compact = async () => {
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
        method: "POST",
      });
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "压缩上下文失败");
    }
  };

  const stop = async () => {
    const activeRunId = runId ?? snapshotQuery.data?.runId ?? null;
    if (activeRunId === null) {
      useChatStore.getState().setError("当前没有可停止的运行");
      return;
    }
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
        body: JSON.stringify({ runId: activeRunId }),
        method: "POST",
      });
    } catch (cause: unknown) {
      useChatStore.getState().setError(cause instanceof Error ? cause.message : "停止失败");
    }
  };

  const resolveUserInput = async (inputId: string, answers: readonly UserInputAnswer[]) => {
    await apiFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/inputs/${encodeURIComponent(inputId)}`,
      {
        body: JSON.stringify({ answers }),
        method: "POST",
      },
    );
  };

  const resolveApproval = async (
    approvalId: string,
    decision: "approved" | "denied",
    options: { allowPrefix?: string; grantSession?: boolean } = {},
  ) => {
    await apiFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { body: JSON.stringify({ decision, ...options }), method: "POST" },
    );
  };

  if (snapshotQuery.isPending) {
    return <div className="page-loading">加载对话…</div>;
  }

  if (snapshotQuery.error !== null) {
    const notFound = snapshotQuery.error instanceof ApiError && snapshotQuery.error.status === 404;
    return (
      <div className="page-error">
        <h2>{notFound ? "对话不存在" : "对话加载失败"}</h2>
        <p>{snapshotQuery.error.message}</p>
        <Link className="btn btn-primary" to="/">
          <ArrowLeft size={15} /> 返回
        </Link>
      </div>
    );
  }

  const snapshot = snapshotQuery.data;
  if (snapshot === undefined) return <div className="page-loading">加载对话…</div>;

  const title = snapshot.session.title;
  const catalog = catalogQuery.data;
  const modelSelection: ModelSelection | null =
    catalog === undefined
      ? null
      : {
          modelId: snapshot.session.modelId ?? catalog.default.modelId,
          providerId: snapshot.session.providerId ?? catalog.default.providerId,
          thinkingLevel: (snapshot.session.thinkingLevel ??
            catalog.default.thinkingLevel) as ThinkingLevel,
        };
  const selectedModelInfo =
    catalog === undefined || modelSelection === null
      ? undefined
      : catalog.providers
          .find((provider) => provider.id === modelSelection.providerId)
          ?.models.find((model) => model.id === modelSelection.modelId);
  const pendingApprovals = Object.values(approvals);
  const parentSession =
    snapshot.session.parentSessionId === null
      ? null
      : (sessionsQuery.data?.find((session) => session.id === snapshot.session.parentSessionId) ??
        null);

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-heading">
          <h1>{title}</h1>
          <div className="chat-sub" title={snapshot.session.workspaceRoot}>
            <span className="chat-workspace">{snapshot.session.workspaceRoot}</span>
            {parentSession !== null ? (
              <>
                <Link className="branch-parent" to={`/s/${parentSession.id}`}>
                  <GitBranch size={11} /> 分支自 {parentSession.title}
                </Link>
                <button
                  className="branch-compare-button"
                  onClick={() => setCompareOpen(true)}
                  type="button"
                >
                  <GitCompare size={11} /> 对比
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="chat-header-meta">
          <fieldset className="chat-view-toggle" aria-label="会话视图">
            <legend className="sr-only">会话视图</legend>
            {(["chat", "trace", "files"] as const).map((item) => (
              <button
                className={view === item ? "active" : ""}
                key={item}
                onClick={() => setView(item)}
                type="button"
              >
                {item === "chat" ? "对话" : item === "trace" ? "轨迹" : "文件"}
              </button>
            ))}
          </fieldset>
          <ContextUsagePopover
            compactionCount={compactionCount}
            contextWindow={selectedModelInfo?.contextWindow ?? 0}
            isRunning={isRunning}
            modelName={selectedModelInfo?.name ?? "当前模型"}
            usage={lastUsage}
          />
          <button
            aria-label="打开工作区"
            className="header-icon-button"
            onClick={() => setWorkspaceOpen(true)}
            title="工作区"
            type="button"
          >
            <FolderTree size={14} />
          </button>
          <button
            aria-label="打开 Git"
            className="header-icon-button"
            onClick={() => setGitOpen(true)}
            title="Git"
            type="button"
          >
            <GitPullRequest size={14} />
          </button>
          <button
            aria-label="打开后台命令"
            className="header-icon-button"
            onClick={() => setCommandsOpen(true)}
            title="后台命令"
            type="button"
          >
            <Terminal size={14} />
          </button>
          <button
            aria-label="查看执行轨迹"
            className="header-icon-button"
            onClick={() => navigate(`/s/${encodeURIComponent(sessionId)}/trace`)}
            title="执行轨迹"
            type="button"
          >
            <Activity size={14} />
          </button>
          <button
            aria-label="查看上下文检查点"
            className="header-icon-button"
            onClick={() => setCheckpointsOpen(true)}
            title="上下文检查点"
            type="button"
          >
            <History size={14} />
          </button>
          <button
            aria-label="压缩上下文"
            className="header-icon-button"
            disabled={isRunning || isCompacting}
            onClick={() => void compact()}
            title="压缩上下文"
            type="button"
          >
            <Shrink size={14} />
          </button>
        </div>
      </header>

      {view === "chat" ? (
        <>
          {attachmentContext !== null ? (
            <div className="chat-attachment-bar">
              <Paperclip size={12} />
              {attachmentContext.attachments.map((attachment) => (
                <span key={attachment.id}>
                  {attachment.fileName} · {attachment.kind}
                </span>
              ))}
            </div>
          ) : null}

          {turns.length > 1 ? (
            <nav aria-label="轮次导航" className="turn-nav">
              {turns.map((turn, index) => (
                <button
                  aria-label={`第 ${index + 1} 轮：${turn.preview}`}
                  className={activeTurn === index ? "active" : ""}
                  key={turn.timestamp}
                  onClick={() => {
                    messageRefs.current.get(turn.timestamp)?.scrollIntoView({
                      behavior: "smooth",
                      block: "start",
                    });
                  }}
                  title={`第 ${index + 1} 轮 · ${turn.preview}`}
                  type="button"
                />
              ))}
            </nav>
          ) : null}

          <div
            className="chat-scroll"
            onScroll={() => {
              const container = chatScrollRef.current;
              if (container === null) return;
              const near = isNearBottom(container);
              setFollowingOutput(near);
              if (near) setUnreadTurns(0);
              const threshold = container.getBoundingClientRect().top + 96;
              let current = 0;
              turns.forEach((turn, index) => {
                const element = messageRefs.current.get(turn.timestamp);
                if (element !== undefined && element.getBoundingClientRect().top <= threshold) {
                  current = index;
                }
              });
              setActiveTurn(current);
            }}
            ref={chatScrollRef}
          >
            <div className="chat-content">
              {visibleMessages.length === 0 && !isRunning ? (
                <WelcomeOnboarding onPick={(text) => void send(text)} />
              ) : null}

              {visibleMessages.length > renderedMessages.length ? (
                <button
                  className="btn btn-ghost load-earlier"
                  onClick={() => setVisibleLimit((value) => value + 80)}
                  type="button"
                >
                  加载更早消息（剩余 {visibleMessages.length - renderedMessages.length} 条）
                </button>
              ) : null}

              {renderedMessages.map((message) => {
                const text = messageText(message);
                const thinking = messageThinking(message);
                const images = messageImages(message);
                return (
                  <article
                    className={`message ${message.role === "user" ? "message-user" : "message-assistant"}${
                      highlighted === message.timestamp ? " message-highlight" : ""
                    }`}
                    key={`${message.role}-${message.timestamp}-${messageText(message).slice(0, 24)}`}
                    ref={(node) => {
                      if (node === null) messageRefs.current.delete(message.timestamp);
                      else messageRefs.current.set(message.timestamp, node);
                    }}
                  >
                    {message.role === "assistant" ? (
                      <div className="avatar assistant-avatar">F</div>
                    ) : null}
                    <div className="message-body">
                      {thinking !== "" ? (
                        <details className="reasoning-panel">
                          <summary>思考过程</summary>
                          <pre>{thinking}</pre>
                        </details>
                      ) : null}
                      {images.length > 0 ? (
                        <div className="message-images">
                          {images.map((image, index) => (
                            <img
                              alt={`用户附件 ${index + 1}`}
                              key={`${image.mimeType}-${image.data.length}-${image.data.slice(-16)}`}
                              src={`data:${image.mimeType};base64,${image.data}`}
                            />
                          ))}
                        </div>
                      ) : null}
                      {message.role === "assistant" ? (
                        <Markdown>{text}</Markdown>
                      ) : text !== "" ? (
                        <div className="user-text">{text}</div>
                      ) : null}
                    </div>
                    <div className="message-actions">
                      <button
                        aria-label="定位到上下文"
                        className="message-fork"
                        onClick={() => jumpToContext(message.timestamp)}
                        title="定位到上下文"
                        type="button"
                      >
                        <LocateFixed size={13} />
                      </button>
                      <button
                        aria-label="复制消息"
                        className="message-fork"
                        onClick={() =>
                          void copyMessage(`${message.role}-${message.timestamp}`, text)
                        }
                        title={
                          copied === `${message.role}-${message.timestamp}` ? "已复制" : "复制"
                        }
                        type="button"
                      >
                        <Copy size={13} />
                      </button>
                      {message.role === "user" ? (
                        <>
                          <button
                            aria-label="编辑并重跑"
                            className="message-fork"
                            disabled={isRunning || text.trim() === ""}
                            onClick={() => setRewriteTarget({ text, timestamp: message.timestamp })}
                            title="编辑并重跑"
                            type="button"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            aria-label="重试这条消息"
                            className="message-fork"
                            disabled={isRunning || retrying !== null || text.trim() === ""}
                            onClick={() => void retryFromMessage(message.timestamp, text)}
                            title="重试这条消息"
                            type="button"
                          >
                            {retrying === message.timestamp ? (
                              <Loader2 className="spin" size={13} />
                            ) : (
                              <RotateCcw size={13} />
                            )}
                          </button>
                          <button
                            aria-label="从这条消息创建分支"
                            className="message-fork"
                            disabled={forking !== null || isRunning}
                            onClick={() => void forkFromMessage(message.timestamp)}
                            title="从这条消息创建分支"
                            type="button"
                          >
                            {forking === message.timestamp ? (
                              <Loader2 className="spin" size={13} />
                            ) : (
                              <GitBranch size={13} />
                            )}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </article>
                );
              })}

              {tools.length > 0 ? (
                <details
                  className="activity-group"
                  open={isRunning || tools.some((tool) => tool.status === "failed")}
                >
                  <summary className="activity-summary">
                    <ChevronDown className="activity-chevron" size={13} />
                    <span>执行过程</span>
                    <span className="activity-count">{tools.length} 个工具</span>
                    {isRunning ? <Loader2 className="spin" size={12} /> : null}
                  </summary>
                  <div className="activity-list">
                    {tools.map((tool) => (
                      <ToolCard
                        isRunning={isRunning}
                        key={tool.id}
                        sessionId={sessionId}
                        tool={tool}
                      />
                    ))}
                  </div>
                </details>
              ) : null}

              <FileChangePanel
                busy={fileChangeBusy}
                changes={fileChanges}
                disabled={isRunning}
                onReplay={() => void applyFileChanges("replay")}
                onUndo={() => void applyFileChanges("undo")}
              />
              {fileChangeNotice !== null ? (
                <div className="file-change-notice" role="status">
                  {fileChangeNotice}
                  <button onClick={() => setFileChangeNotice(null)} type="button">
                    知道了
                  </button>
                </div>
              ) : null}

              <SubAgentBoard agents={Object.values(subAgents)} />

              {reasoningText !== "" ? (
                <details className="reasoning-panel reasoning-streaming" open>
                  <summary>
                    <Loader2 className="spin" size={11} /> 正在思考
                  </summary>
                  <pre>{reasoningText}</pre>
                </details>
              ) : null}

              {streamingText !== "" ? (
                <article className="message message-assistant">
                  <div className="avatar assistant-avatar">F</div>
                  <div className="message-body">
                    <Markdown>{streamingText}</Markdown>
                    <span className="caret" />
                  </div>
                </article>
              ) : null}

              {isRunning && streamingText === "" && tools.length === 0 ? (
                <div className="thinking">
                  <Loader2 className="spin" size={12} />
                  正在思考…
                </div>
              ) : null}

              {error !== null ? (
                <div className="inline-error error-banner" role="alert">
                  <AlertTriangle size={15} />
                  <span>{error}</span>
                  {!isRunning ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void resumeSession()}
                      type="button"
                    >
                      继续上次任务
                    </button>
                  ) : null}
                  <button
                    className="error-dismiss"
                    onClick={() => useChatStore.getState().dismissError()}
                    type="button"
                  >
                    知道了
                  </button>
                </div>
              ) : null}

              {plan !== null && !isRunning ? (
                <section className="plan-card">
                  <div className="plan-card-head">
                    <span>计划已生成</span>
                    <button
                      className="btn btn-primary"
                      onClick={() => void approvePlan()}
                      type="button"
                    >
                      批准并执行
                    </button>
                  </div>
                  <div className="plan-card-body">
                    <Markdown>{plan.text}</Markdown>
                  </div>
                  <div className="plan-card-revise">
                    <label className="plan-card-revise-label" htmlFor="plan-revision">
                      不满意？用自然语言说明要改什么
                    </label>
                    <textarea
                      id="plan-revision"
                      maxLength={2_000}
                      onChange={(event) => setPlanRevision(event.target.value)}
                      placeholder="例如：先补测试再改接口；不要改动数据库结构。"
                      rows={2}
                      value={planRevision}
                    />
                    <button
                      className="btn btn-ghost"
                      disabled={planRevision.trim() === "" || revisingPlan}
                      onClick={() => void revisePlan()}
                      type="button"
                    >
                      {revisingPlan ? "生成中…" : "生成下一版计划"}
                    </button>
                  </div>
                </section>
              ) : null}

              {pendingApprovals.length > 0 ? (
                <div className="approval-stack">
                  <div className="approval-stack-head">
                    待批准操作 <span>{pendingApprovals.length}</span>
                  </div>
                  {pendingApprovals.map((approval) => (
                    <ApprovalCard
                      approval={approval}
                      key={approval.approvalId}
                      onResolve={(decision, options) =>
                        resolveApproval(approval.approvalId, decision, options)
                      }
                    />
                  ))}
                </div>
              ) : null}

              {retryNotice !== null ? (
                <div className="retry-notice" role="status">
                  {retryNotice}
                </div>
              ) : null}

              {!followingOutput ? (
                <button
                  className="chat-jump-bottom"
                  onClick={() => {
                    setFollowingOutput(true);
                    setUnreadTurns(0);
                    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                  }}
                  type="button"
                >
                  回到底部
                  {unreadTurns > 0 ? ` · ${unreadTurns} 条新消息` : ""}
                </button>
              ) : null}

              <div ref={bottomRef} />
            </div>
          </div>
        </>
      ) : view === "trace" ? (
        <div className="chat-view">
          <TraceView sessionId={sessionId} />
        </div>
      ) : (
        <div className="chat-view chat-files-view">
          <WorkspaceBrowser sessionId={sessionId} workspaceRoot={snapshot.session.workspaceRoot} />
        </div>
      )}

      {gitOpen ? <GitDrawer onClose={() => setGitOpen(false)} sessionId={sessionId} /> : null}

      {commandsOpen ? (
        <BackgroundCommandDrawer onClose={() => setCommandsOpen(false)} sessionId={sessionId} />
      ) : null}

      {workspaceOpen ? (
        <WorkspaceDrawer
          onClose={() => setWorkspaceOpen(false)}
          sessionId={sessionId}
          workspaceRoot={snapshot.session.workspaceRoot}
        />
      ) : null}

      {compareOpen && parentSession !== null ? (
        <BranchCompareDialog
          baseSessionId={parentSession.id}
          onClose={() => setCompareOpen(false)}
          targetSessionId={sessionId}
        />
      ) : null}

      {checkpointsOpen ? (
        <CheckpointDialog
          isRunning={isRunning}
          onClose={() => setCheckpointsOpen(false)}
          sessionId={sessionId}
        />
      ) : null}

      {rewriteTarget !== null ? (
        <RewriteDialog
          initialText={rewriteTarget.text}
          onClose={() => setRewriteTarget(null)}
          sessionId={sessionId}
          timestamp={rewriteTarget.timestamp}
        />
      ) : null}

      {view === "chat" ? (
        <div className="composer-wrap">
          <WorkCapsule plan={plan} todos={todos} />
          {Object.values(userInputs).map((input) => (
            <UserInputCard
              input={input}
              key={input.inputId}
              onResolve={(answers) => resolveUserInput(input.inputId, answers)}
            />
          ))}
          <QueueChips items={queued} onRemove={(id) => void removeQueued(id)} />
          <Composer
            key={sessionId}
            controls={<ApprovalPicker disabled={isRunning} />}
            isRunning={isRunning}
            onSend={(text, images, attachments) => send(text, images, attachments)}
            onSteer={steer}
            onStop={stop}
            onTogglePlanMode={() => setPlanMode((value) => !value)}
            planMode={planMode}
            sessionId={sessionId}
            trailingControls={
              <ModelPicker
                disabled={isRunning}
                onChange={(selection) => void changeModel(selection)}
                value={modelSelection}
              />
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function WelcomeOnboarding({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = [
    "列出当前工作区的文件，并概括项目结构",
    "读取 README，告诉我这个项目怎么运行",
    "帮我创建一个 hello.ts，并运行它",
  ];
  return (
    <section className="welcome">
      <div className="welcome-mark">A</div>
      <h2>开始一段本地对话</h2>
      <p>
        Agent 会读写当前 workspace，并在执行命令或修改文件前请求你的批准。先在设置中接入模型
        API，即可开始。
      </p>
      <div className="suggestions">
        {suggestions.map((suggestion) => (
          <button
            className="suggestion"
            key={suggestion}
            onClick={() => onPick(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <Link className="welcome-link" to="/literature">
        <BookOpen size={15} /> 也可以上传 PDF 生成知识清单
      </Link>
    </section>
  );
}
