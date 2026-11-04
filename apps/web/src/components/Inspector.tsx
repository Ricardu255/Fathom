import type { FileChange } from "@harness/core";
import { Bot, FileDiff, FolderTree, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SubAgentState } from "../stores/chat-store";
import { FileChangePanel } from "./FileChangePanel";
import { clampInspectorWidth, INSPECTOR_DEFAULT_WIDTH, widthFromDrag } from "./inspector-width";
import { SubAgentBoard } from "./SubAgentBoard";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

type InspectorTab = "agents" | "changes" | "files";

const TABS: readonly { icon: typeof FolderTree; label: string; value: InspectorTab }[] = [
  { icon: FolderTree, label: "文件", value: "files" },
  { icon: FileDiff, label: "变更", value: "changes" },
  { icon: Bot, label: "子 Agent", value: "agents" },
];

export interface InspectorProps {
  agents: readonly SubAgentState[];
  busy: "replay" | "undo" | null;
  changes: readonly FileChange[];
  onClose: () => void;
  onReplay: (() => void) | undefined;
  onUndo: (() => void) | undefined;
  sessionId: string;
  workspaceRoot: string;
}

/**
 * 右侧统一 Inspector：文件树、文件变更、子 Agent 三处原来分散的入口收在这里，
 * 宽度可拖拽，窗口变窄时先压缩自己而不是挤掉对话区。
 */
export function Inspector(props: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("files");
  const [width, setWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const drag = useRef<{ startWidth: number; startX: number } | null>(null);

  useEffect(() => {
    const onResize = () => setWidth((current) => clampInspectorWidth(current, window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const endDrag = () => {
    drag.current = null;
  };

  return (
    <aside className="inspector" style={{ width }}>
      <button
        aria-label="拖动调整侧栏宽度"
        className="inspector-resize"
        onPointerCancel={endDrag}
        onPointerDown={(event) => {
          drag.current = { startWidth: width, startX: event.clientX };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active === null) return;
          setWidth(
            widthFromDrag({
              deltaX: event.clientX - active.startX,
              startWidth: active.startWidth,
              viewportWidth: window.innerWidth,
            }),
          );
        }}
        onPointerUp={endDrag}
        type="button"
      />
      <div className="inspector-tabs">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          return (
            <button
              className={tab === tabItem.value ? "active" : ""}
              key={tabItem.value}
              onClick={() => setTab(tabItem.value)}
              type="button"
            >
              <Icon size={13} />
              {tabItem.label}
            </button>
          );
        })}
        <button
          aria-label="关闭侧栏"
          className="inspector-close"
          onClick={props.onClose}
          type="button"
        >
          <X size={14} />
        </button>
      </div>
      <div className="inspector-body">
        {tab === "files" ? (
          <WorkspaceBrowser sessionId={props.sessionId} workspaceRoot={props.workspaceRoot} />
        ) : tab === "changes" ? (
          props.changes.length === 0 ? (
            <p className="inspector-empty">本次运行还没有文件变更。</p>
          ) : (
            <FileChangePanel
              busy={props.busy}
              changes={props.changes}
              onReplay={props.onReplay}
              onUndo={props.onUndo}
            />
          )
        ) : props.agents.length === 0 ? (
          <p className="inspector-empty">还没有派发子 Agent。</p>
        ) : (
          <SubAgentBoard agents={props.agents} />
        )}
      </div>
    </aside>
  );
}
