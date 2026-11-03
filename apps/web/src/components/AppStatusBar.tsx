import { useQuery } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { settingsQueryOptions } from "../api/queries";
import { useChatStore } from "../stores/chat-store";

export function AppStatusBar({ onToggleNav }: { onToggleNav?: () => void }) {
  const location = useLocation();
  const settingsQuery = useQuery(settingsQueryOptions());
  const isSession = location.pathname.startsWith("/s/");
  const isRunning = useChatStore((state) => state.isRunning);
  const isCompacting = useChatStore((state) => state.isCompacting);
  const lastUsage = useChatStore((state) => state.lastUsage);
  const memoryRecall = useChatStore((state) => state.memoryRecall);
  const compactionCount = useChatStore((state) => state.compactionCount);
  const queued = useChatStore((state) => state.queued);
  const status = !isSession
    ? "本地工作台"
    : isCompacting
      ? "压缩中"
      : isRunning
        ? "运行中"
        : "就绪";

  return (
    <header className="app-statusbar">
      {onToggleNav === undefined ? null : (
        <button
          aria-label="打开导航"
          className="mobile-nav-toggle"
          onClick={onToggleNav}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="M3 5.5h14M3 10h14M3 14.5h14" />
          </svg>
        </button>
      )}
      <div className="app-statusbar-left">
        <span className="app-status-brand">Fathom</span>
        <span className="app-status-separator" />
        <span className={`status-dot${isRunning ? " running" : ""}`} />
        <span className="app-status-text">{status}</span>
      </div>
      <div className="app-statusbar-right">
        {isSession && lastUsage !== null ? (
          <span className="app-status-item">
            {Math.round(lastUsage.inputTokens / 1000)}k in / {lastUsage.outputTokens} out
          </span>
        ) : null}
        {isSession && memoryRecall !== null ? (
          <span className="app-status-item" title={memoryRecall.titles.join("；")}>
            {memoryRecall.titles.length} 条记忆
          </span>
        ) : null}
        {isSession && compactionCount > 0 ? (
          <span className="app-status-item">{compactionCount} 次压缩</span>
        ) : null}
        {isSession && queued.length > 0 ? (
          <span className="app-status-item">{queued.length} 条排队</span>
        ) : null}
        <span className="app-status-separator" />
        <span className="app-status-item">
          {settingsQuery.data?.apiKeyConfigured === false
            ? "未配置模型"
            : (settingsQuery.data?.model ?? "model")}
        </span>
        <span className="app-status-local">本地</span>
      </div>
    </header>
  );
}
