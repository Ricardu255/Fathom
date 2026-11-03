import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  Folder,
  Loader2,
  Save,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api/client";
import { queryKeys, sessionFilesQueryOptions, workspaceFileQueryOptions } from "../api/queries";
import type { WorkspaceFileView } from "../api/types";

export function WorkspaceBrowser({
  sessionId,
  workspaceRoot,
}: {
  sessionId: string;
  workspaceRoot: string;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const filesQuery = useQuery(sessionFilesQueryOptions(sessionId, "."));
  const fileQuery = useQuery(workspaceFileQueryOptions(sessionId, selectedPath ?? ""));

  useEffect(() => {
    if (fileQuery.data !== undefined) {
      setDraft(fileQuery.data.content);
      setNotice(null);
    }
  }, [fileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (input: { content: string; path: string }) =>
      apiFetch<WorkspaceFileView>(`/api/sessions/${encodeURIComponent(sessionId)}/file`, {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    onSuccess: async (file) => {
      setNotice(`已保存 ${file.path}`);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.workspaceFile(sessionId, file.path),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.sessionFiles(sessionId, "."),
      });
    },
  });

  const entries = useMemo(() => {
    const all = filesQuery.data?.entries ?? [];
    const needle = filter.trim().toLocaleLowerCase();
    return all.filter((entry) => needle === "" || entry.path.toLocaleLowerCase().includes(needle));
  }, [filesQuery.data, filter]);
  const dirty =
    selectedPath !== null && fileQuery.data !== undefined && draft !== fileQuery.data.content;
  const canReveal = typeof window.fathom?.workspace?.reveal === "function";

  return (
    <div className="workspace-browser">
      <aside className="workspace-tree">
        <input
          aria-label="过滤文件"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="过滤文件…"
          value={filter}
        />
        <div className="workspace-tree-list">
          {filesQuery.isPending ? (
            <div className="muted-text">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="muted-text">没有文件。</div>
          ) : (
            entries.map((entry) => {
              const depth = entry.path.split("/").length - 1;
              return (
                <button
                  className={`workspace-entry${selectedPath === entry.path ? " active" : ""}`}
                  disabled={entry.type === "directory"}
                  key={`${entry.type}-${entry.path}`}
                  onClick={() => {
                    if (entry.type === "file") setSelectedPath(entry.path);
                  }}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                  type="button"
                >
                  {entry.type === "directory" ? (
                    <Folder size={12} />
                  ) : (
                    <FileKindIcon path={entry.path} />
                  )}
                  <span>{entry.path.split("/").at(-1)}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>
      <section className="workspace-editor">
        {selectedPath === null ? (
          <div className="workspace-placeholder">选择一个文件开始预览。</div>
        ) : fileQuery.isPending ? (
          <div className="workspace-placeholder">加载中…</div>
        ) : fileQuery.error !== null ? (
          <div className="inline-error">{fileQuery.error.message}</div>
        ) : (
          <>
            <div className="workspace-editor-head">
              <span>{selectedPath}</span>
              <span>{fileQuery.data?.size ?? 0} 字节</span>
              <span className="dialog-spacer" />
              {notice !== null ? <span className="workspace-notice">{notice}</span> : null}
              {canReveal && selectedPath !== null ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    const absolute = `${workspaceRoot.replace(/[\\/]+$/u, "")}/${selectedPath}`;
                    void window.fathom?.workspace?.reveal(absolute);
                  }}
                  title="在系统文件管理器中打开"
                  type="button"
                >
                  <ExternalLink size={13} />
                  打开
                </button>
              ) : null}
              <button
                className="btn btn-primary"
                disabled={!dirty || saveMutation.isPending}
                onClick={() => {
                  if (selectedPath !== null) {
                    saveMutation.mutate({ content: draft, path: selectedPath });
                  }
                }}
                type="button"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <Save size={14} />
                )}
                保存
              </button>
            </div>
            {saveMutation.error !== null ? (
              <div className="inline-error">{saveMutation.error.message}</div>
            ) : null}
            <textarea
              aria-label="文件内容"
              className="workspace-textarea"
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              value={draft}
            />
          </>
        )}
      </section>
    </div>
  );
}

function FileKindIcon({ path }: { path: string }) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(extension)) {
    return <FileImage size={12} />;
  }
  if (["json", "lock"].includes(extension)) return <FileJson size={12} />;
  if (["csv", "xlsx", "xls", "ods"].includes(extension)) return <FileSpreadsheet size={12} />;
  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "css",
      "scss",
      "html",
      "md",
      "py",
      "rs",
      "go",
    ].includes(extension)
  ) {
    return <FileCode2 size={12} />;
  }
  return <FileText size={12} />;
}
