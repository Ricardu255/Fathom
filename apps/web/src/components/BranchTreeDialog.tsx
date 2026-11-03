import { GitBranch, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { Session } from "../api/types";
import {
  buildSessionTree,
  countBranchNodes,
  type SessionTreeNode,
} from "../features/chat/session-tree";

export function BranchTreeDialog({
  currentSessionId,
  onClose,
  sessions,
}: {
  currentSessionId: string | null;
  onClose: () => void;
  sessions: readonly Session[];
}) {
  const navigate = useNavigate();
  const tree = buildSessionTree(sessions);

  return (
    <div className="dialog-backdrop">
      <div
        aria-labelledby="branch-tree-title"
        aria-modal="true"
        className="dialog-panel dialog-wide"
        role="dialog"
      >
        <div className="dialog-head">
          <div>
            <h2 id="branch-tree-title">分支树</h2>
            <div className="branch-tree-sub">
              {countBranchNodes(tree)} 个会话 · {tree.length} 个根节点
            </div>
          </div>
          <button aria-label="关闭" className="dialog-close" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">
          {tree.length === 0 ? (
            <p className="muted-text">还没有会话。</p>
          ) : (
            <div className="branch-tree">
              {tree.map((node) => (
                <BranchRow
                  currentSessionId={currentSessionId}
                  depth={0}
                  key={node.session.id}
                  node={node}
                  onSelect={(session) => {
                    onClose();
                    navigate(`/s/${session.id}`);
                  }}
                />
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

function BranchRow({
  currentSessionId,
  depth,
  node,
  onSelect,
}: {
  currentSessionId: string | null;
  depth: number;
  node: SessionTreeNode;
  onSelect: (session: Session) => void;
}) {
  const active = node.session.id === currentSessionId;
  return (
    <>
      <button
        className={`branch-row${active ? " active" : ""}`}
        onClick={() => onSelect(node.session)}
        style={{ paddingLeft: `${10 + depth * 18}px` }}
        type="button"
      >
        <GitBranch size={13} />
        <span className="branch-row-title">{node.session.title}</span>
        <span className="branch-row-meta">
          {node.children.length > 0 ? `${node.children.length} 个分支 · ` : ""}
          {node.session.lastSeq} 事件
        </span>
      </button>
      {node.children.map((child) => (
        <BranchRow
          currentSessionId={currentSessionId}
          depth={depth + 1}
          key={child.session.id}
          node={child}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
