import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { gitDiffQueryOptions, gitStatusQueryOptions, queryKeys } from "../api/queries";

export function GitDrawer({ onClose, sessionId }: { onClose: () => void; sessionId: string }) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(gitStatusQueryOptions(sessionId));
  const [selectedPath, setSelectedPath] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const files = statusQuery.data?.files ?? [];
  const selected = files.find((file) => file.path === selectedPath);
  const diffQuery = useQuery(
    gitDiffQueryOptions(sessionId, selectedPath, selected?.staged ?? false),
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(sessionId) });
    await queryClient.invalidateQueries({
      queryKey: ["sessions", sessionId, "git", "diff"],
    });
  };

  const stageMutation = useMutation({
    mutationFn: (paths: string[]) =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/stage`, {
        body: JSON.stringify({ paths }),
        method: "POST",
      }),
    onSuccess: refresh,
    onError: (error: unknown) => setNotice(error instanceof Error ? error.message : "暂存失败"),
  });
  const unstageMutation = useMutation({
    mutationFn: (paths: string[]) =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/git/unstage`, {
        body: JSON.stringify({ paths }),
        method: "POST",
      }),
    onSuccess: refresh,
    onError: (error: unknown) => setNotice(error instanceof Error ? error.message : "取消暂存失败"),
  });
  const commitMutation = useMutation({
    mutationFn: (commitMessage: string) =>
      apiFetch<{ output: string; status: unknown }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/commit`,
        { body: JSON.stringify({ message: commitMessage }), method: "POST" },
      ),
    onSuccess: async (result) => {
      setMessage("");
      setNotice(result.output.split("\n")[0] ?? "已提交");
      await refresh();
    },
    onError: (error: unknown) => setNotice(error instanceof Error ? error.message : "提交失败"),
  });

  return (
    <div className="workspace-drawer" role="dialog" aria-label="Git">
      <div className="workspace-drawer-head">
        <div>
          <h2>
            <GitBranch size={16} /> Git
          </h2>
          <p>{statusQuery.data?.branch ?? "读取仓库状态…"}</p>
        </div>
        <button aria-label="关闭 Git" className="dialog-close" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>
      <div className="git-body">
        {statusQuery.error !== null ? (
          <div className="inline-error">{statusQuery.error.message}</div>
        ) : null}
        {notice !== null ? <div className="workflow-notice">{notice}</div> : null}
        <div className="git-layout">
          <aside className="git-files">
            <div className="git-files-head">
              <span>变更</span>
              <span>{files.length}</span>
            </div>
            {statusQuery.isPending ? (
              <div className="muted-text">加载中…</div>
            ) : files.length === 0 ? (
              <div className="muted-text">工作区干净。</div>
            ) : (
              files.map((file) => (
                <div
                  className={`git-file-row${selectedPath === file.path ? " active" : ""}`}
                  key={file.path}
                >
                  <button
                    className="git-file-name"
                    onClick={() => setSelectedPath(file.path)}
                    type="button"
                  >
                    <span className="git-file-state">
                      {file.staged ? "S" : file.worktree === "?" ? "?" : "M"}
                    </span>
                    {file.path}
                  </button>
                  <button
                    aria-label={file.staged ? `取消暂存 ${file.path}` : `暂存 ${file.path}`}
                    className="session-action"
                    onClick={() =>
                      file.staged
                        ? unstageMutation.mutate([file.path])
                        : stageMutation.mutate([file.path])
                    }
                    type="button"
                  >
                    {file.staged ? <RotateCcw size={12} /> : <Plus size={12} />}
                  </button>
                </div>
              ))
            )}
          </aside>
          <section className="git-diff">
            {selectedPath === "" ? (
              <div className="workspace-placeholder">选择一个文件查看 diff。</div>
            ) : diffQuery.isPending ? (
              <div className="workspace-placeholder">加载 diff…</div>
            ) : diffQuery.error !== null ? (
              <div className="inline-error">{diffQuery.error.message}</div>
            ) : (
              <pre>{diffQuery.data || "(no diff)"}</pre>
            )}
          </section>
        </div>
        <div className="git-commit">
          <input
            aria-label="提交信息"
            maxLength={500}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Commit message"
            value={message}
          />
          <button
            className="btn btn-primary"
            disabled={message.trim() === "" || commitMutation.isPending}
            onClick={() => commitMutation.mutate(message.trim())}
            type="button"
          >
            {commitMutation.isPending ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <GitBranch size={14} />
            )}
            提交已暂存
          </button>
        </div>
      </div>
    </div>
  );
}
