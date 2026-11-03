import type { ContextCheckpoint } from "@harness/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, GitCompare, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { checkpointCompareQueryOptions, checkpointsQueryOptions, queryKeys } from "../api/queries";
import type { CheckpointView } from "../api/types";

const FIELD_LABELS: Record<keyof ContextCheckpoint, string> = {
  blockers: "阻塞",
  completed: "已完成",
  constraints: "约束",
  decisions: "决策",
  goal: "目标",
  nextSteps: "下一步",
  pending: "待完成",
};

export function CheckpointDialog({
  isRunning,
  onClose,
  sessionId,
}: {
  isRunning: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const queryClient = useQueryClient();
  const checkpointsQuery = useQuery(checkpointsQueryOptions(sessionId));
  const [baseId, setBaseId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkpoints = [...(checkpointsQuery.data ?? [])].sort(
    (left, right) => right.seq - left.seq,
  );
  const compareQuery = useQuery(checkpointCompareQueryOptions(sessionId, baseId, targetId));

  useEffect(() => {
    if (checkpoints.length === 0) return;
    setTargetId((current) => (current === "" ? (checkpoints[0]?.checkpointId ?? "") : current));
    setBaseId((current) => {
      if (current !== "") return current;
      return checkpoints[1]?.checkpointId ?? "";
    });
  }, [checkpoints]);

  const restoreMutation = useMutation({
    mutationFn: (checkpointId: string) =>
      apiFetch<{ checkpointId: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
        { method: "POST" },
      ),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "恢复检查点失败");
    },
    onSuccess: async () => {
      setError(null);
      setNotice("检查点已恢复；下一次发送消息时会注入该工作状态。");
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });

  const compareWithPrevious = (checkpoint: CheckpointView) => {
    const previous =
      checkpoints.find((item) => item.checkpointId === checkpoint.previousCheckpointId) ??
      checkpoints.find((item) => item.seq < checkpoint.seq);
    if (previous === undefined) {
      setError("没有更早的检查点可以对比");
      return;
    }
    setBaseId(previous.checkpointId);
    setTargetId(checkpoint.checkpointId);
    setNotice(null);
    setError(null);
  };

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="checkpoint-title"
        aria-modal="true"
        className="dialog-panel dialog-wide checkpoint-dialog"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="checkpoint-title">上下文检查点</h2>
            <div className="branch-tree-sub">
              结构化工作状态、版本链与双版本对比；恢复会在下一次发送时生效。
            </div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {checkpointsQuery.error !== null ? (
            <div className="inline-error">{checkpointsQuery.error.message}</div>
          ) : checkpointsQuery.isPending ? (
            <p className="muted-text">加载检查点…</p>
          ) : checkpoints.length === 0 ? (
            <p className="muted-text">
              还没有结构化检查点。上下文自动压缩或点击“压缩上下文”后，这里会出现版本记录。
            </p>
          ) : (
            <>
              {notice !== null ? <div className="checkpoint-notice">{notice}</div> : null}
              {error !== null ? <div className="inline-error">{error}</div> : null}

              <div className="checkpoint-compare-controls">
                <label>
                  基准
                  <select onChange={(event) => setBaseId(event.target.value)} value={baseId}>
                    <option value="">选择检查点</option>
                    {checkpoints.map((checkpoint) => (
                      <option key={checkpoint.checkpointId} value={checkpoint.checkpointId}>
                        {checkpointLabel(checkpoint)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="checkpoint-arrow">→</span>
                <label>
                  目标
                  <select onChange={(event) => setTargetId(event.target.value)} value={targetId}>
                    <option value="">选择检查点</option>
                    {checkpoints.map((checkpoint) => (
                      <option key={checkpoint.checkpointId} value={checkpoint.checkpointId}>
                        {checkpointLabel(checkpoint)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {baseId === "" || targetId === "" || baseId === targetId ? (
                <p className="muted-text">选择两个不同的检查点查看结构化差异。</p>
              ) : compareQuery.error !== null ? (
                <div className="inline-error">{compareQuery.error.message}</div>
              ) : compareQuery.isPending ? (
                <p className="muted-text">对比中…</p>
              ) : (compareQuery.data?.fields.length ?? 0) === 0 ? (
                <p className="muted-text">两个检查点的工作状态相同。</p>
              ) : (
                <div className="checkpoint-diff">
                  {compareQuery.data?.fields.map((entry) => (
                    <section className="checkpoint-diff-field" key={entry.field}>
                      <h4>{FIELD_LABELS[entry.field]}</h4>
                      {entry.removed.map((item) => (
                        <p className="checkpoint-diff-removed" key={`removed-${item}`}>
                          − {item}
                        </p>
                      ))}
                      {entry.added.map((item) => (
                        <p className="checkpoint-diff-added" key={`added-${item}`}>
                          + {item}
                        </p>
                      ))}
                    </section>
                  ))}
                </div>
              )}

              <div className="checkpoint-list">
                {checkpoints.map((checkpoint) => (
                  <article className="checkpoint-card" key={checkpoint.checkpointId}>
                    <header>
                      <div>
                        <strong>{formatTime(checkpoint.createdAt)}</strong>
                        <span>
                          {checkpoint.trigger === "manual" ? "手动压缩" : "自动压缩"} · 事件 #
                          {checkpoint.coveredFromSeq}–{checkpoint.coveredToSeq}
                        </span>
                      </div>
                      <div className="checkpoint-card-actions">
                        <button
                          className="btn btn-ghost"
                          onClick={() => compareWithPrevious(checkpoint)}
                          type="button"
                        >
                          <GitCompare size={12} /> 对比上一版
                        </button>
                        <button
                          className="btn btn-primary"
                          disabled={isRunning || restoreMutation.isPending}
                          onClick={() => restoreMutation.mutate(checkpoint.checkpointId)}
                          type="button"
                        >
                          {restoreMutation.isPending &&
                          restoreMutation.variables === checkpoint.checkpointId ? (
                            <Loader2 className="spin" size={12} />
                          ) : (
                            <RotateCcw size={12} />
                          )}
                          恢复
                        </button>
                      </div>
                    </header>
                    <CheckpointSummary checkpoint={checkpoint} />
                    {checkpoint.summary.trim() !== "" ? (
                      <details className="checkpoint-summary">
                        <summary>压缩摘要</summary>
                        <p>{checkpoint.summary}</p>
                      </details>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckpointSummary({ checkpoint }: { checkpoint: CheckpointView }) {
  const value = checkpoint.checkpoint;
  const rows: Array<[string, string[]]> = [
    ["目标", value.goal === "" ? [] : [value.goal]],
    ["约束", value.constraints],
    ["决策", value.decisions],
    ["已完成", value.completed],
    ["待完成", value.pending],
    ["阻塞", value.blockers],
    ["下一步", value.nextSteps],
  ];
  return (
    <dl className="checkpoint-fields">
      {rows
        .filter(([, items]) => items.length > 0)
        .map(([label, items]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {items.slice(0, 3).map((item) => (
                <span key={item}>
                  <CheckCircle2 size={10} /> {item}
                </span>
              ))}
              {items.length > 3 ? <em>+{items.length - 3} 项</em> : null}
            </dd>
          </div>
        ))}
    </dl>
  );
}

function checkpointLabel(checkpoint: CheckpointView): string {
  return `${formatTime(checkpoint.createdAt)} · #${checkpoint.seq} · ${checkpoint.trigger === "manual" ? "手动" : "自动"}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
