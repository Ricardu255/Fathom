import type { FileChange } from "@harness/core";
import { FileDiff, Loader2, RotateCcw, RotateCw } from "lucide-react";

export function FileChangePanel({
  busy = null,
  changes,
  disabled = false,
  onReplay,
  onUndo,
}: {
  busy?: "replay" | "undo" | null;
  changes: readonly FileChange[];
  disabled?: boolean;
  onReplay?: (() => void) | undefined;
  onUndo?: (() => void) | undefined;
}) {
  if (changes.length === 0) return null;
  return (
    <section className="file-change-group">
      <div className="tool-group-label">文件变更</div>
      {changes.map((change) => (
        <details
          className="file-change"
          key={`${change.path}-${change.diff}`}
          open={changes.length === 1}
        >
          <summary>
            <FileDiff size={15} />
            <span className="file-change-path">{change.path}</span>
            <DiffStats diff={change.diff} />
          </summary>
          <pre className="diff-view">
            {diffLines(change.diff).map((item) => (
              <span className={item.className} key={item.key}>
                {item.line || " "}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      ))}
      {onUndo !== undefined && onReplay !== undefined ? (
        <div className="file-change-actions">
          <button
            className="btn btn-ghost"
            disabled={disabled || busy !== null}
            onClick={onUndo}
            type="button"
          >
            {busy === "undo" ? <Loader2 className="spin" size={12} /> : <RotateCcw size={12} />}
            撤销全部变更
          </button>
          <button
            className="btn btn-ghost"
            disabled={disabled || busy !== null}
            onClick={onReplay}
            type="button"
          >
            {busy === "replay" ? <Loader2 className="spin" size={12} /> : <RotateCw size={12} />}
            重放全部变更
          </button>
        </div>
      ) : null}
    </section>
  );
}

function DiffStats({ diff }: { diff: string }) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return (
    <span className="diff-stats">
      <span className="diff-add">+{added}</span>
      <span className="diff-del">-{removed}</span>
    </span>
  );
}

function diffLines(diff: string): { className: string; key: string; line: string }[] {
  const counts = new Map<string, number>();
  return diff.split("\n").map((line) => {
    const count = counts.get(line) ?? 0;
    counts.set(line, count + 1);
    return { className: diffLineClass(line), key: `${line}:${count}`, line };
  });
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:"))
    return "diff-meta";
  if (line.startsWith("+")) return "diff-add-line";
  if (line.startsWith("-")) return "diff-del-line";
  if (line.startsWith("@@")) return "diff-hunk";
  return "diff-context";
}
