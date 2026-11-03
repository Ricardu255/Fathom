import { X } from "lucide-react";
import type { QueuedInput } from "../api/types";

export function QueueChips({
  items,
  onRemove,
}: {
  items: readonly QueuedInput[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="queue-chips">
      <span className="queue-label">排队中</span>
      {items.map((item) => (
        <span className="queue-chip" key={item.id} title={item.text}>
          <span className="queue-text">{item.text}</span>
          <button
            aria-label="移除排队消息"
            className="queue-remove"
            onClick={() => onRemove(item.id)}
            type="button"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
