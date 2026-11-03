import type { ApprovalRequestedData } from "@harness/core/events";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: ApprovalRequestedData;
  onResolve: (
    decision: "approved" | "denied",
    options?: { allowPrefix?: string; grantSession?: boolean },
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const highRisk = approval.risk === "high";
  const isCommandTool =
    approval.toolName === "run_command" || approval.toolName === "start_background_command";
  const prefixRule = approval.prefixRule;

  const resolve = async (
    decision: "approved" | "denied",
    options?: { allowPrefix?: string; grantSession?: boolean },
  ) => {
    if (pending !== null) return;
    setPending(decision);
    setError(null);
    try {
      await onResolve(decision, options);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "审批失败");
      setPending(null);
    }
  };

  return (
    <section className={`approval-card${highRisk ? " high-risk" : ""}`} aria-live="polite">
      <div className="approval-heading">
        <ShieldAlert size={16} />
        <div className="approval-heading-copy">
          <div className="approval-title">
            需要你的批准
            <span className={`approval-risk${highRisk ? " high" : ""}`}>
              {highRisk ? "高风险" : "常规"}
            </span>
          </div>
          <div className="approval-subtitle">
            <code>{approval.toolName}</code> 请求执行下列操作
            {approval.executionId !== undefined ? "（来自子 Agent）" : ""}
          </div>
        </div>
      </div>
      <div className="approval-summary">{approval.summary}</div>
      {approval.target !== undefined || approval.consequence !== undefined ? (
        <div className="approval-meta">
          {approval.target !== undefined ? (
            <div>
              <span>目标</span>
              <code title={approval.target}>{approval.target}</code>
            </div>
          ) : null}
          {approval.consequence !== undefined ? (
            <div>
              <span>影响</span>
              <p>{approval.consequence}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      <details className="approval-raw">
        <summary>查看参数</summary>
        <pre className="tool-pre approval-input">{JSON.stringify(approval.input, null, 2)}</pre>
      </details>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="approval-actions">
        {prefixRule !== undefined && !highRisk ? (
          <button
            className="btn btn-ghost approval-secondary"
            disabled={pending !== null}
            onClick={() => void resolve("approved", { allowPrefix: prefixRule })}
            type="button"
          >
            允许类似命令
          </button>
        ) : null}
        {!isCommandTool && !highRisk ? (
          <button
            className="btn btn-ghost approval-secondary"
            disabled={pending !== null}
            onClick={() => void resolve("approved", { grantSession: true })}
            type="button"
          >
            本次会话允许
          </button>
        ) : null}
        <button
          className="btn btn-ghost"
          disabled={pending !== null}
          onClick={() => void resolve("denied")}
          type="button"
        >
          {pending === "denied" ? "正在拒绝…" : "拒绝"}
        </button>
        <button
          className="btn btn-primary"
          disabled={pending !== null}
          onClick={() => void resolve("approved")}
          type="button"
        >
          {pending === "approved" ? "正在批准…" : "批准并执行"}
        </button>
      </div>
    </section>
  );
}
