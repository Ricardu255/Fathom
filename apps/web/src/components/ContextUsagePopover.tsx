import type { UsageData } from "@harness/core";
import { Activity, X } from "lucide-react";
import { useState } from "react";

export function ContextUsagePopover(props: {
  compactionCount: number;
  contextWindow: number;
  isRunning: boolean;
  modelName: string;
  usage: UsageData | null;
}) {
  const [open, setOpen] = useState(false);
  const used = props.usage?.inputTokens ?? 0;
  const percent =
    props.contextWindow > 0 ? Math.min(100, Math.max(0, (used / props.contextWindow) * 100)) : 0;
  const remaining = Math.max(0, props.contextWindow - used);

  return (
    <div className="context-usage">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`context-usage-trigger${percent >= 80 ? " warning" : ""}`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Activity size={10} />
        <span>{props.contextWindow > 0 ? `${percent.toFixed(0)}%` : "—"}</span>
      </button>
      {open ? (
        <>
          <button
            aria-label="关闭上下文用量"
            className="context-usage-backdrop"
            onClick={() => setOpen(false)}
            type="button"
          />
          <div aria-label="上下文用量" className="context-usage-panel" role="dialog">
            <div className="context-usage-head">
              <div>
                <strong>上下文用量</strong>
                <span>{props.modelName}</span>
              </div>
              <button
                aria-label="关闭"
                className="dialog-close"
                onClick={() => setOpen(false)}
                type="button"
              >
                <X size={14} />
              </button>
            </div>
            <div className="context-usage-meter" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </div>
            <div className="context-usage-value">
              <strong>{formatTokens(used)}</strong>
              <span>
                / {props.contextWindow > 0 ? formatTokens(props.contextWindow) : "未知窗口"}
              </span>
              <em>{percent.toFixed(1)}%</em>
            </div>
            <dl className="context-usage-grid">
              <div>
                <dt>最近请求输入</dt>
                <dd>{props.usage === null ? "尚无请求" : formatTokens(props.usage.inputTokens)}</dd>
              </div>
              <div>
                <dt>最近请求输出</dt>
                <dd>{props.usage === null ? "—" : formatTokens(props.usage.outputTokens)}</dd>
              </div>
              <div>
                <dt>剩余窗口</dt>
                <dd>{props.contextWindow > 0 ? formatTokens(remaining) : "—"}</dd>
              </div>
              <div>
                <dt>上下文压缩</dt>
                <dd>{props.compactionCount} 次</dd>
              </div>
            </dl>
            <p className="context-usage-foot">
              {props.isRunning
                ? "当前请求仍在运行，用量会继续增长。"
                : props.usage === null
                  ? "发送第一条消息后会显示最近一次请求的上下文用量。"
                  : "基于最近一次模型请求的输入 Token；下一次请求会重新计算。"}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}k`;
  return String(tokens);
}
