import { isValidElement, type ReactNode, useEffect, useId, useState } from "react";

interface ChartData {
  labels?: string[];
  values: number[];
}

export function RichCodeBlock({ children }: { children: ReactNode }) {
  const code = extractCode(children);
  if (code !== null) {
    if (code.language === "mermaid") return <MermaidDiagram source={code.text} />;
    if (code.language === "chart") return <BarChart source={code.text} />;
  }
  return <pre>{children}</pre>;
}

function extractCode(children: ReactNode): { language: string; text: string } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  const className = child.props.className ?? "";
  const match = /language-([\w-]+)/u.exec(className);
  const text = flatten(child.props.children);
  return match?.[1] === undefined ? null : { language: match[1], text };
}

function flatten(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(flatten).join("");
  return "";
}

function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          fontFamily:
            'MiSans, "Noto Sans SC", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
          securityLevel: "strict",
          startOnLoad: false,
          theme: "neutral",
        });
        const rendered = await mermaid.render(`mermaid-${id}`, source);
        if (!cancelled) setSvg(rendered.svg);
      } catch (cause: unknown) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Mermaid 渲染失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (error !== null)
    return (
      <pre className="rich-block-error">
        {source}\n\n{error}
      </pre>
    );
  if (svg === null) return <div className="rich-block-loading">正在渲染 Mermaid 图表…</div>;
  return (
    <div
      aria-label="Mermaid 图表"
      className="rich-mermaid"
      role="img"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid 在 strict securityLevel 下生成 SVG，且只渲染本地内容。
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function BarChart({ source }: { source: string }) {
  let data: ChartData | null = null;
  try {
    const parsed = JSON.parse(source) as Partial<ChartData>;
    if (Array.isArray(parsed.values) && parsed.values.every((value) => typeof value === "number")) {
      data = {
        values: parsed.values,
        ...(Array.isArray(parsed.labels) ? { labels: parsed.labels.map(String) } : {}),
      };
    }
  } catch {
    data = null;
  }
  if (data === null || data.values.length === 0) {
    return <pre className="rich-block-error">{source}</pre>;
  }
  const width = 560;
  const height = 180;
  const padding = 24;
  const max = Math.max(1, ...data.values);
  const gap = 6;
  const barWidth = Math.max(
    4,
    (width - padding * 2 - gap * (data.values.length - 1)) / data.values.length,
  );
  return (
    <div aria-label="柱状图" className="rich-chart" role="img">
      <svg viewBox={`0 0 ${width} ${height}`}>
        <title>柱状图</title>
        {data.values.map((value, index) => {
          const barHeight = ((height - padding * 2) * value) / max;
          const x = padding + index * (barWidth + gap);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 柱状图按数据顺序渲染，索引与数值共同稳定。
            <g key={`${index}-${value}`}>
              <rect
                fill="#a8c9e4"
                height={barHeight}
                rx={2}
                width={barWidth}
                x={x}
                y={height - padding - barHeight}
              />
              {data.labels?.[index] !== undefined ? (
                <text
                  fill="#74736e"
                  fontSize="9"
                  textAnchor="middle"
                  x={x + barWidth / 2}
                  y={height - padding + 12}
                >
                  {data.labels[index]}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
