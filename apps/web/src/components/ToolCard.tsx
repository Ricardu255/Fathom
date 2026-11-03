import { Check, ChevronDown, Loader2, Terminal, Wrench, X } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../api/client";
import type { ToolRun } from "../stores/chat-store";

const STATUS_LABEL = {
  completed: "完成",
  failed: "失败",
  running: "执行中",
} as const;

export function ToolCard({
  isRunning = false,
  sessionId,
  tool,
}: {
  isRunning?: boolean;
  sessionId?: string | undefined;
  tool: ToolRun;
}) {
  const [fullResult, setFullResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFullResult = async () => {
    if (sessionId === undefined || loading || fullResult !== null) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await apiFetch<{ result: string | null }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(tool.id)}`,
      );
      setFullResult(payload.result ?? tool.result ?? "");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "加载完整结果失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <details
      className={`tool-card tool-${tool.status}`}
      onToggle={(event) => {
        if (event.currentTarget.open && tool.resultTruncated === true) void loadFullResult();
      }}
      open={tool.status !== "completed"}
    >
      <summary>
        <span className="tool-icon">
          {tool.name === "run_command" ? <Terminal size={13} /> : <Wrench size={13} />}
        </span>
        <span className="tool-name">{tool.name}</span>
        <span className={`tool-status status-${tool.status}`}>
          {tool.status === "running" ? (
            <Loader2 className="spin" size={11} />
          ) : tool.status === "failed" ? (
            <X size={11} />
          ) : (
            <Check size={11} />
          )}
          {STATUS_LABEL[tool.status]}
        </span>
        <ChevronDown className="tool-chevron" size={12} />
      </summary>
      <div className="tool-body">
        <div className="tool-section-label">参数</div>
        <pre className="tool-pre">{JSON.stringify(tool.input, null, 2)}</pre>
        {tool.result !== undefined ? (
          <>
            <div className="tool-section-label">
              结果
              {tool.resultTruncated === true ? (
                <span className="tool-result-meta">
                  {fullResult === null ? "预览 16k" : "完整结果"}
                </span>
              ) : null}
            </div>
            {tool.name === "web_search" ? (
              <WebSearchResults text={fullResult ?? tool.result} />
            ) : tool.name === "web_fetch" ? (
              <WebFetchResult text={fullResult ?? tool.result} />
            ) : (
              <pre className="tool-pre">{fullResult ?? tool.result}</pre>
            )}
            {tool.resultTruncated === true && fullResult === null ? (
              <button
                className="btn btn-ghost tool-load-more"
                disabled={loading || sessionId === undefined || isRunning}
                onClick={() => void loadFullResult()}
                type="button"
              >
                {loading ? <Loader2 className="spin" size={12} /> : null}
                {loading ? "加载中…" : "加载完整结果"}
              </button>
            ) : null}
          </>
        ) : null}
        {error !== null ? <div className="inline-error">{error}</div> : null}
        {tool.error !== undefined ? (
          <>
            <div className="tool-section-label">错误</div>
            <pre className="tool-pre tool-error">{tool.error}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

interface SearchResult {
  summary: string;
  title: string;
  url: string;
}

function WebSearchResults({ text }: { text: string }) {
  const results: SearchResult[] = [];
  let current: SearchResult | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const heading = /^\d+\.\s+(.+)$/u.exec(line);
    if (heading !== null) {
      if (current !== null) results.push(current);
      current = { summary: "", title: heading[1] ?? "", url: "" };
      continue;
    }
    if (current === null) continue;
    if (/^https?:\/\//u.test(line) && current.url === "") current.url = line;
    else if (current.url !== "")
      current.summary = `${current.summary}${current.summary === "" ? "" : " "}${line}`;
  }
  if (current !== null) results.push(current);
  if (results.length === 0) return <pre className="tool-pre">{text}</pre>;
  return (
    <div className="web-result-list">
      {results.map((result) => (
        <article className="web-result-card" key={`${result.url}|${result.title}`}>
          <a href={result.url} rel="noopener noreferrer" target="_blank">
            {result.title || result.url}
          </a>
          <span>{result.url}</span>
          {result.summary !== "" ? <p>{result.summary}</p> : null}
        </article>
      ))}
    </div>
  );
}

function WebFetchResult({ text }: { text: string }) {
  const [head = "", ...rest] = text.split("\n\n");
  const lines = head.split("\n");
  const url = lines.find((line) => line.startsWith("URL: "))?.slice(5) ?? "";
  const status = lines.find((line) => line.startsWith("状态: "))?.slice(4) ?? "";
  const contentType = lines.find((line) => line.startsWith("Content-Type: "))?.slice(14) ?? "";
  return (
    <div className="web-fetch-result">
      <div className="web-fetch-head">
        {url !== "" ? (
          <a href={url} rel="noopener noreferrer" target="_blank">
            {url}
          </a>
        ) : null}
        <span>
          {status}
          {contentType === "" ? "" : ` · ${contentType}`}
        </span>
      </div>
      <pre className="tool-pre">{rest.join("\n\n")}</pre>
    </div>
  );
}
