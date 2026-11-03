import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import { workflowRunsQueryOptions } from "../api/queries";
import type { WorkflowRecord, WorkflowRunRecord } from "../api/types";

const STATUS_LABEL: Record<WorkflowRunRecord["status"], string> = {
  aborted: "已中止",
  completed: "已完成",
  failed: "失败",
  running: "运行中",
};

export function WorkflowHistoryDialog({
  onClose,
  workflow,
}: {
  onClose: () => void;
  workflow: WorkflowRecord;
}) {
  const runsQuery = useQuery(workflowRunsQueryOptions(workflow.id));
  const runs = runsQuery.data ?? [];

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="workflow-history-title"
        aria-modal="true"
        className="dialog-panel dialog-wide"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="workflow-history-title">运行历史</h2>
            <div className="branch-tree-sub">{workflow.title}</div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {runsQuery.isPending ? (
            <p className="muted-text">加载中…</p>
          ) : runs.length === 0 ? (
            <p className="muted-text">还没有运行记录。</p>
          ) : (
            <div className="workflow-history">
              {runs.map((run) => (
                <article className="workflow-history-row" key={run.id}>
                  <span className={`workflow-run-status status-${run.status}`}>
                    {STATUS_LABEL[run.status]}
                  </span>
                  <div>
                    <div className="workflow-history-time">
                      {new Date(run.startedAt).toLocaleString()}
                    </div>
                    <div className="workflow-history-meta">
                      {run.endedAt === null
                        ? "尚未结束"
                        : `耗时 ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1_000))} 秒`}
                    </div>
                  </div>
                  <Link className="btn btn-ghost" to={`/s/${run.sessionId}`}>
                    <ExternalLink size={13} /> 打开
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <span className="dialog-spacer" />
          <button className="btn btn-ghost" onClick={onClose} type="button">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
