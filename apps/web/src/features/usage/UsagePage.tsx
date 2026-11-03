import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, Cpu, Database, Loader2, Sparkles } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { usageQueryOptions } from "../../api/queries";
import type { UsageBreakdown, UsageDay } from "../../api/types";

export function UsagePage() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(dateOffset(today, -364));
  const [to, setTo] = useState(today);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const usageQuery = useQuery(
    usageQueryOptions({
      from,
      to,
      ...(providerId === "" ? {} : { providerId }),
      ...(modelId === "" ? {} : { modelId }),
    }),
  );
  const usage = usageQuery.data;
  const modelOptions = (usage?.byModel ?? []).filter(
    (item) => providerId === "" || item.providerId === providerId,
  );
  const providerOptions = usage?.byProvider ?? [];

  return (
    <div className="usage-page">
      <header className="page-header">
        <div>
          <div className="settings-eyebrow">Observability</div>
          <h1>用量统计</h1>
          <p>从本机 JSONL 事实源聚合主 Agent、子 Agent 与压缩请求的 token 用量。</p>
        </div>
      </header>

      <div className="usage-filters">
        <label>
          开始
          <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </label>
        <label>
          结束
          <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </label>
        <label>
          Provider
          <select
            onChange={(event) => {
              setProviderId(event.target.value);
              setModelId("");
            }}
            value={providerId}
          >
            <option value="">全部</option>
            {providerOptions.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.providerId}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select onChange={(event) => setModelId(event.target.value)} value={modelId}>
            <option value="">全部</option>
            {modelOptions.map((model) => (
              <option key={`${model.providerId}:${model.modelId}`} value={model.modelId}>
                {model.modelId}
              </option>
            ))}
          </select>
        </label>
      </div>

      {usageQuery.isPending ? (
        <div className="page-loading">
          <Loader2 className="spin" size={16} /> 聚合用量…
        </div>
      ) : usageQuery.error !== null || usage === undefined ? (
        <div className="inline-error">{usageQuery.error?.message ?? "无法读取用量"}</div>
      ) : (
        <>
          <div className="usage-kpis">
            <Kpi
              icon={<Activity size={15} />}
              label="总 Token"
              value={formatTokens(usage.totalTokens)}
            />
            <Kpi icon={<BarChart3 size={15} />} label="请求数" value={String(usage.requests)} />
            <Kpi
              icon={<Cpu size={15} />}
              label="费用估算"
              value={usage.costComplete ? formatUsd(usage.costUsd) : `${formatUsd(usage.costUsd)}+`}
            />
            <Kpi
              icon={<Database size={15} />}
              label="压缩 / 子 Agent"
              value={`${usage.compactionCount} / ${usage.subAgentRuns}`}
            />
          </div>

          <section className="usage-section">
            <div className="usage-section-head">
              <h2>每日热力图</h2>
              <span>{usage.days.length} 天</span>
            </div>
            <UsageHeatmap days={usage.days} />
          </section>

          <section className="usage-section">
            <div className="usage-section-head">
              <h2>最近 30 天趋势</h2>
              <span>请求 / Token</span>
            </div>
            <UsageTrend days={usage.days.slice(-30)} />
          </section>

          <section className="usage-section">
            <div className="usage-section-head">
              <h2>按模型</h2>
              <span>{usage.byModel.length} 个模型</span>
            </div>
            <UsageTable rows={usage.byModel} />
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="usage-kpi">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function UsageHeatmap({ days }: { days: UsageDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens));
  const leading = days[0] === undefined ? 0 : new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
  const blanks = Array.from({ length: leading }, (_, index) => `blank-${index}`);
  return (
    <div className="usage-heatmap" role="img" aria-label="每日 Token 热力图">
      {blanks.map((key) => (
        <span className="usage-heat-cell blank" key={key} />
      ))}
      {days.map((day) => {
        const total = day.inputTokens + day.outputTokens;
        const level = total === 0 ? 0 : Math.min(4, Math.ceil((total / max) * 4));
        return (
          <span
            className={`usage-heat-cell level-${level}`}
            key={day.date}
            title={`${day.date} · ${formatTokens(total)} tokens · ${day.requests} 请求`}
          />
        );
      })}
    </div>
  );
}

function UsageTrend({ days }: { days: UsageDay[] }) {
  const maxRequests = Math.max(1, ...days.map((day) => day.requests));
  const maxTokens = Math.max(1, ...days.map((day) => day.inputTokens + day.outputTokens));
  return (
    <div className="usage-trend">
      <div className="usage-trend-bars">
        {days.map((day) => (
          <span
            className="usage-trend-request"
            key={`r-${day.date}`}
            style={{ height: `${Math.max(2, (day.requests / maxRequests) * 100)}%` }}
            title={`${day.date} · ${day.requests} 请求`}
          />
        ))}
      </div>
      <div className="usage-trend-bars tokens">
        {days.map((day) => (
          <span
            className="usage-trend-token"
            key={`t-${day.date}`}
            style={{
              height: `${Math.max(2, ((day.inputTokens + day.outputTokens) / maxTokens) * 100)}%`,
            }}
            title={`${day.date} · ${formatTokens(day.inputTokens + day.outputTokens)} tokens`}
          />
        ))}
      </div>
    </div>
  );
}

function UsageTable({ rows }: { rows: UsageBreakdown[] }) {
  const totalTokens = useMemo(
    () =>
      Math.max(
        1,
        rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
      ),
    [rows],
  );
  if (rows.length === 0) return <p className="muted-text">该时间范围内没有用量。</p>;
  return (
    <div className="usage-table">
      {rows.map((row) => {
        const total = row.inputTokens + row.outputTokens;
        return (
          <div className="usage-row" key={`${row.providerId}:${row.modelId}`}>
            <span className="usage-row-model">
              <Sparkles size={12} />
              {row.modelId}
              <small>{row.providerId}</small>
            </span>
            <span>{formatTokens(row.inputTokens)} in</span>
            <span>{formatTokens(row.outputTokens)} out</span>
            <span>{row.requests} 请求</span>
            <span>{row.costUsd === null ? "费用未知" : formatUsd(row.costUsd)}</span>
            <span className="usage-row-bar" aria-hidden="true">
              <i style={{ width: `${Math.max(2, (total / totalTokens) * 100)}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function dateOffset(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

function formatUsd(value: number): string {
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}
