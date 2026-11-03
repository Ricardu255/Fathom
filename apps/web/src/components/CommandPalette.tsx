import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Bot,
  Brain,
  GitFork,
  LayoutGrid,
  type LucideIcon,
  MessageSquarePlus,
  Search,
  Settings2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sessionSearchQueryOptions, sessionsQueryOptions } from "../api/queries";

const OPEN_EVENT = "harness:open-command-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface PaletteItem {
  action: () => void;
  hint: string;
  icon: LucideIcon;
  key: string;
  label: string;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionsQuery = useQuery({ ...sessionsQueryOptions(), enabled: open });
  const searchQuery = useQuery({
    ...sessionSearchQueryOptions(query),
    enabled: open && query.trim() !== "",
  });
  const trimmed = query.trim().toLocaleLowerCase();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape" && open) {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const close = () => setOpen(false);
  const commands: PaletteItem[] = [
    {
      action: () => navigate("/"),
      hint: "开始一段新对话",
      icon: MessageSquarePlus,
      key: "command:new",
      label: "新建对话",
    },
    {
      action: () => navigate("/board"),
      hint: "打开任务看板",
      icon: LayoutGrid,
      key: "command:board",
      label: "任务看板",
    },
    {
      action: () => navigate("/literature"),
      hint: "打开文献解析",
      icon: BookOpen,
      key: "command:literature",
      label: "文献解析",
    },
    {
      action: () => navigate("/memory"),
      hint: "打开长期记忆",
      icon: Brain,
      key: "command:memory",
      label: "长期记忆",
    },
    {
      action: () => navigate("/workflows"),
      hint: "编排并直接运行子 Agent DAG",
      icon: GitFork,
      key: "command:workflows",
      label: "工作流",
    },
    {
      action: () => navigate("/settings"),
      hint: "主题、审批模式与模型 API",
      icon: Settings2,
      key: "command:settings",
      label: "设置",
    },
  ];
  const filteredCommands = commands.filter(
    (item) =>
      trimmed === "" ||
      item.label.toLocaleLowerCase().includes(trimmed) ||
      item.hint.toLocaleLowerCase().includes(trimmed),
  );
  const recentSessions =
    trimmed === ""
      ? (sessionsQuery.data ?? []).slice(0, 5).map(
          (session): PaletteItem => ({
            action: () => navigate(`/s/${session.id}`),
            hint: `${session.lastSeq} 事件 · ${session.workspaceRoot}`,
            icon: Bot,
            key: `session:${session.id}`,
            label: session.title,
          }),
        )
      : [];
  const searchHits =
    trimmed === ""
      ? []
      : (searchQuery.data ?? []).map(
          (hit): PaletteItem => ({
            action: () => navigate(`/s/${hit.sessionId}`),
            hint: hit.matchedTitle ? "标题匹配" : `${hit.role ?? "消息"} · ${hit.snippet}`,
            icon: Search,
            key: `hit:${hit.sessionId}:${hit.seq ?? "title"}`,
            label: hit.title,
          }),
        );
  const items = [...filteredCommands, ...recentSessions, ...searchHits];
  const run = (item: PaletteItem) => {
    close();
    item.action();
  };

  return (
    <div className="palette-backdrop">
      <div aria-label="命令面板" aria-modal="true" className="palette-panel" role="dialog">
        <div className="palette-search">
          <Search size={15} />
          <input
            aria-label="搜索会话或命令"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(items.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                const item = items[activeIndex];
                if (item !== undefined) run(item);
              }
            }}
            placeholder="搜索对话、跳转页面…"
            ref={inputRef}
            value={query}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-results">
          {items.length === 0 ? (
            <div className="palette-empty">
              {searchQuery.isFetching ? "搜索中…" : "没有匹配结果"}
            </div>
          ) : (
            items.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  className={`palette-item${index === activeIndex ? " active" : ""}`}
                  key={item.key}
                  onClick={() => run(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  type="button"
                >
                  <Icon size={14} />
                  <span className="palette-item-body">
                    <span className="palette-item-label">{item.label}</span>
                    <span className="palette-item-hint">{item.hint}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="palette-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>⌘/Ctrl K 开关</span>
        </div>
      </div>
    </div>
  );
}
