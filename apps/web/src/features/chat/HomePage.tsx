import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Code2, FolderOpen, FolderPlus, Lightbulb, Loader2, PenLine, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../../api/client";
import {
  modelCatalogQueryOptions,
  queryKeys,
  settingsQueryOptions,
  workspacesQueryOptions,
} from "../../api/queries";
import type { AttachmentView, ChatImage, Session } from "../../api/types";
import { ApprovalPicker } from "../../components/ApprovalPicker";
import { openCommandPalette } from "../../components/CommandPalette";
import { Composer } from "../../components/Composer";
import { ModelPicker, type ModelSelection } from "../../components/ModelPicker";
import { useAddWorkspace } from "../workspaces/use-add-workspace";

const QUICK_PROMPTS = [
  { icon: PenLine, label: "写作", prompt: "帮我起草并润色以下内容：" },
  { icon: Code2, label: "编程", prompt: "帮我解决这个编程问题：" },
  { icon: Search, label: "研究", prompt: "研究并比较以下内容：" },
  { icon: Lightbulb, label: "创意", prompt: "围绕以下主题集思广益：" },
] as const;

export function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(settingsQueryOptions());
  const workspacesQuery = useQuery(workspacesQueryOptions());
  const catalogQuery = useQuery(modelCatalogQueryOptions());
  const addWorkspace = useAddWorkspace();
  const [searchParams] = useSearchParams();
  const [planMode, setPlanMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ text: string; version: number } | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    searchParams.get("workspace"),
  );
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const promptVersion = useRef(0);
  const notConfigured = settingsQuery.data?.apiKeyConfigured === false;
  const workspaces = (workspacesQuery.data ?? []).filter(
    (workspace) => workspace.removedAt === null,
  );
  const requestedWorkspaceId = searchParams.get("workspace");
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ??
    workspaces.find((workspace) => workspace.isAvailable) ??
    workspaces[0];
  const selection: ModelSelection | null =
    modelSelection ??
    (catalogQuery.data === undefined
      ? null
      : {
          modelId: catalogQuery.data.default.modelId,
          providerId: catalogQuery.data.default.providerId,
          thinkingLevel: catalogQuery.data.default.thinkingLevel as ModelSelection["thinkingLevel"],
        });

  useEffect(() => {
    if (requestedWorkspaceId !== null) setSelectedWorkspaceId(requestedWorkspaceId);
  }, [requestedWorkspaceId]);

  const applyQuickPrompt = (text: string) => {
    promptVersion.current += 1;
    setPrompt({ text, version: promptVersion.current });
  };

  const addWorkspaceAndSelect = async () => {
    setError(null);
    setAddingWorkspace(true);
    try {
      const workspace = await addWorkspace();
      if (workspace !== null) setSelectedWorkspaceId(workspace.id);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "添加工作区失败");
    } finally {
      setAddingWorkspace(false);
    }
  };

  const send = async (
    text: string,
    images: readonly ChatImage[],
    documentIds: readonly string[],
    files: readonly File[],
  ) => {
    setError(null);
    if (selectedWorkspace === undefined || !selectedWorkspace.isAvailable) {
      const message = "请先选择可用的工作区";
      setError(message);
      throw new Error(message);
    }
    let sessionId: string | null = null;
    let accepted = false;
    try {
      const session = await apiFetch<Session>("/api/sessions", {
        body: JSON.stringify({
          ...(selection === null
            ? {}
            : {
                modelId: selection.modelId,
                providerId: selection.providerId,
                thinkingLevel: selection.thinkingLevel,
              }),
          workspaceId: selectedWorkspace.id,
        }),
        method: "POST",
      });
      sessionId = session.id;

      const uploadedIds: string[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const attachment = await apiFetch<AttachmentView>(
          `/api/sessions/${encodeURIComponent(session.id)}/attachments`,
          { body: form, method: "POST" },
        );
        uploadedIds.push(attachment.id);
      }

      await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
        body: JSON.stringify({
          attachments: [...documentIds, ...uploadedIds],
          images,
          planMode,
          text,
        }),
        method: "POST",
      });
      accepted = true;
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      navigate(`/s/${session.id}`);
    } catch (cause: unknown) {
      if (sessionId !== null && !accepted) {
        await apiFetch<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        }).catch(() => undefined);
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }
      const message = cause instanceof Error ? cause.message : "发送失败";
      setError(message);
      throw cause;
    }
  };

  return (
    <div className="home-page">
      <header className="home-navbar">
        <div className="home-navbar-copy">
          <h1>新对话</h1>
          <span>开始一段全新的对话</span>
        </div>
        <button className="btn btn-ghost home-search" onClick={openCommandPalette} type="button">
          <Search size={14} />
          <span>搜索</span>
          <kbd>⌘K</kbd>
        </button>
      </header>

      <div className="home-scroll">
        <section className="home-hero">
          <p aria-hidden="true" className="home-eyebrow">
            ATELIER FATHOM · N° 001
          </p>
          <p aria-hidden="true" className="home-script">
            Bonjour
          </p>
          <h2>我们从哪里开始？</h2>
          <p className="home-subtitle">描述任务、添加图片或文档，直接在本地开始一段对话。</p>

          {notConfigured ? (
            <div className="home-model-warning">
              尚未配置模型 API。
              <Link to="/settings">前往设置</Link>
            </div>
          ) : null}

          <div className="home-workspace-row">
            <FolderOpen size={12} />
            <span>工作区</span>
            {workspaces.length === 0 ? (
              <em>{workspacesQuery.isPending ? "加载中…" : "无工作区"}</em>
            ) : (
              <select
                aria-label="选择工作区"
                onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                value={selectedWorkspace?.id ?? ""}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.displayName}
                    {workspace.isAvailable ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            )}
            <button
              aria-label="添加工作区"
              className="home-workspace-add"
              disabled={addingWorkspace}
              onClick={() => void addWorkspaceAndSelect()}
              title="添加工作区"
              type="button"
            >
              {addingWorkspace ? <Loader2 className="spin" size={11} /> : <FolderPlus size={11} />}
            </button>
          </div>

          <Composer
            {...(prompt === null
              ? {}
              : { initialPrompt: prompt.text, initialPromptVersion: prompt.version })}
            controls={<ApprovalPicker />}
            disabled={selectedWorkspace === undefined || !selectedWorkspace.isAvailable}
            isRunning={false}
            onSend={send}
            onSteer={async () => undefined}
            onStop={async () => undefined}
            onTogglePlanMode={() => setPlanMode((value) => !value)}
            placeholder="输入任何问题"
            planMode={planMode}
            trailingControls={
              <ModelPicker
                disabled={catalogQuery.isPending}
                onChange={setModelSelection}
                value={selection}
              />
            }
          />

          {error !== null ? (
            <p className="home-error" role="alert">
              {error}
            </p>
          ) : null}

          <fieldset className="home-shortcuts">
            <legend className="sr-only">快捷提示</legend>
            {QUICK_PROMPTS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => applyQuickPrompt(item.prompt)}
                  type="button"
                >
                  <Icon size={11} />
                  {item.label}
                </button>
              );
            })}
          </fieldset>

          <p className="home-footnote">本地优先 · 工具执行前会请求批准 · 会话保存在你的机器上</p>
        </section>
      </div>
    </div>
  );
}
