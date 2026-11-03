import { X } from "lucide-react";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

export function WorkspaceDrawer({
  onClose,
  sessionId,
  workspaceRoot,
}: {
  onClose: () => void;
  sessionId: string;
  workspaceRoot: string;
}) {
  return (
    <div aria-label="工作区文件" className="workspace-drawer" role="dialog">
      <div className="workspace-drawer-head">
        <div>
          <h2>工作区</h2>
          <p>浏览并编辑文本文件；二进制与超过 1MB 的文件只读。</p>
        </div>
        <button aria-label="关闭工作区" className="dialog-close" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>
      <div className="workspace-drawer-body">
        <WorkspaceBrowser sessionId={sessionId} workspaceRoot={workspaceRoot} />
      </div>
    </div>
  );
}
