import { useMutation } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { RewriteResult } from "../api/types";

export function RewriteDialog({
  initialText,
  onClose,
  sessionId,
  timestamp,
}: {
  initialText: string;
  onClose: () => void;
  sessionId: string;
  timestamp: number;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<RewriteResult>(`/api/sessions/${encodeURIComponent(sessionId)}/rewrite`, {
        body: JSON.stringify({ fromTimestamp: timestamp, text }),
        method: "POST",
      }),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "创建改写分支失败");
    },
    onSuccess: (result) => {
      onClose();
      navigate(`/s/${result.session.id}`);
    },
  });

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="rewrite-title"
        aria-modal="true"
        className="dialog-panel rewrite-dialog"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="rewrite-title">编辑并重跑</h2>
            <div className="branch-tree-sub">
              从这条消息之前创建新分支，不会删除旧分支；新分支会立即开始运行。
            </div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <textarea
            aria-label="改写后的消息"
            className="rewrite-input"
            maxLength={100_000}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            value={text}
          />
          {error !== null ? <div className="inline-error">{error}</div> : null}
          <div className="rewrite-actions">
            <button className="btn btn-ghost" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={text.trim() === "" || mutation.isPending}
              onClick={() => mutation.mutate()}
              type="button"
            >
              {mutation.isPending ? <Loader2 className="spin" size={13} /> : null}
              创建分支并运行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
