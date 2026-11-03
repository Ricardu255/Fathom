import { type AgentMessage, messageText } from "@harness/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitMerge, Loader2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import { mergePreviewQueryOptions, queryKeys, sessionCompareQueryOptions } from "../api/queries";
import type { Session } from "../api/types";

export function BranchCompareDialog({
  baseSessionId,
  onClose,
  targetSessionId,
}: {
  baseSessionId: string;
  onClose: () => void;
  targetSessionId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const compareQuery = useQuery(sessionCompareQueryOptions(baseSessionId, targetSessionId));
  const mergePreviewQuery = useQuery(mergePreviewQueryOptions(baseSessionId, targetSessionId));
  const mergeMutation = useMutation({
    mutationFn: () =>
      apiFetch<Session>(`/api/sessions/${encodeURIComponent(targetSessionId)}/merge`, {
        body: JSON.stringify({ sourceSessionId: baseSessionId }),
        method: "POST",
      }),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      onClose();
      navigate(`/s/${session.id}`);
    },
  });
  const codeMergeMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ session: Session }>(
        `/api/sessions/${encodeURIComponent(targetSessionId)}/merge-code`,
        {
          body: JSON.stringify({ sourceSessionId: baseSessionId }),
          method: "POST",
        },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      onClose();
      navigate(`/s/${result.session.id}`);
    },
  });
  const diff = compareQuery.data;
  const mergeFiles = mergePreviewQuery.data ?? [];
  const conflicts = mergeFiles.filter((file) => file.conflict);

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="branch-compare-title"
        aria-modal="true"
        className="dialog-panel dialog-wide"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="branch-compare-title">分支对比</h2>
            <div className="branch-tree-sub">
              {diff === undefined ? "加载中…" : `共同前缀 ${diff.commonPrefix} 条消息`}
            </div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {compareQuery.error !== null ? (
            <div className="inline-error">{compareQuery.error.message}</div>
          ) : diff === undefined ? (
            <p className="muted-text">加载分支差异…</p>
          ) : (
            <div className="branch-compare-grid">
              <CompareSide
                changes={diff.base.fileChanges}
                messages={diff.base.messages}
                title={diff.base.title}
              />
              <CompareSide
                changes={diff.target.fileChanges}
                messages={diff.target.messages}
                title={diff.target.title}
              />
            </div>
          )}
          <section className="branch-code-merge">
            <h4>代码三方合并</h4>
            {mergePreviewQuery.isPending ? (
              <p className="muted-text">计算代码差异…</p>
            ) : mergeFiles.length === 0 ? (
              <p className="muted-text">两个分支没有文件级差异。</p>
            ) : (
              <>
                <p className="muted-text">
                  {mergeFiles.length} 个文件有差异，{conflicts.length} 个冲突。
                </p>
                {mergeFiles.map((file) => (
                  <details className="branch-compare-change" key={file.path}>
                    <summary>
                      {file.path} {file.conflict ? "· 冲突" : "· 可自动合并"}
                    </summary>
                    <pre>{file.merged ?? "(删除文件)"}</pre>
                  </details>
                ))}
              </>
            )}
            {mergePreviewQuery.error !== null ? (
              <div className="inline-error">{mergePreviewQuery.error.message}</div>
            ) : null}
            {codeMergeMutation.error !== null ? (
              <div className="inline-error">{codeMergeMutation.error.message}</div>
            ) : null}
            <button
              className="btn btn-primary"
              disabled={
                codeMergeMutation.isPending || mergeFiles.length === 0 || conflicts.length > 0
              }
              onClick={() => codeMergeMutation.mutate()}
              type="button"
            >
              {codeMergeMutation.isPending ? (
                <Loader2 className="spin" size={14} />
              ) : (
                <GitMerge size={14} />
              )}
              应用三方代码合并
            </button>
          </section>
          {mergeMutation.error !== null ? (
            <div className="inline-error">{mergeMutation.error.message}</div>
          ) : null}
        </div>
        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button className="btn btn-ghost" onClick={onClose} type="button">
            关闭
          </button>
          <button
            className="btn btn-primary"
            disabled={mergeMutation.isPending || diff === undefined}
            onClick={() => mergeMutation.mutate()}
            type="button"
          >
            {mergeMutation.isPending ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <GitMerge size={14} />
            )}
            摘要合并新分支
          </button>
        </div>
      </div>
    </div>
  );
}

function CompareSide({
  changes,
  messages,
  title,
}: {
  changes: { diff: string; path: string }[];
  messages: AgentMessage[];
  title: string;
}) {
  return (
    <section className="branch-compare-side">
      <h3>{title}</h3>
      <h4>分叉后消息</h4>
      {messages.length === 0 ? (
        <p className="muted-text">没有独有消息。</p>
      ) : (
        messages.slice(-20).map((message) => (
          <div
            className="branch-compare-message"
            key={`${message.role}-${message.timestamp}-${messageText(message).slice(0, 24)}`}
          >
            {messageText(message) || "[非文本消息]"}
          </div>
        ))
      )}
      <h4>文件变更</h4>
      {changes.length === 0 ? (
        <p className="muted-text">没有独有文件变更。</p>
      ) : (
        changes.map((change) => (
          <details className="branch-compare-change" key={change.path}>
            <summary>{change.path}</summary>
            <pre>{change.diff.slice(0, 4_000)}</pre>
          </details>
        ))
      )}
    </section>
  );
}
