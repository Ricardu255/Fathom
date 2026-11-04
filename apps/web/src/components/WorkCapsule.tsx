import type { PlanCreatedData, TodoItem } from "@harness/core";
import { Ban, CheckCircle2, Circle, ListChecks, Loader2, ScrollText } from "lucide-react";
import { summarizeWork } from "../features/chat/work-summary";

const STATUS_ICON = {
  blocked: Ban,
  completed: CheckCircle2,
  in_progress: Loader2,
  pending: Circle,
} as const;

/**
 * 输入框上方的一条状态胶囊：平时只占一行，展开才看明细，
 * 避免原本独立的「计划卡 + 任务清单」把 Composer 挤下去。
 */
export function WorkCapsule({
  plan,
  todos,
}: {
  plan: PlanCreatedData | null;
  todos: readonly TodoItem[];
}) {
  const summary = summarizeWork({ plan, todos });
  if (!summary.hasWork) return null;
  return (
    <details className="work-capsule">
      <summary>
        <ListChecks size={14} />
        {summary.todoTotal > 0 ? (
          <span className="work-capsule-count">
            {summary.todoCompleted}/{summary.todoTotal}
          </span>
        ) : null}
        {summary.planActive ? (
          <span className="work-capsule-plan">
            <ScrollText size={12} />
            计划
          </span>
        ) : null}
        {summary.currentStep !== null ? (
          <span className="work-capsule-step">{summary.currentStep}</span>
        ) : null}
      </summary>
      <div className="work-capsule-body">
        {summary.todoTotal > 0 ? (
          <ul className="todo-list">
            {todos.map((todo) => {
              const Icon = STATUS_ICON[todo.status] ?? Circle;
              return (
                <li className={`todo-item todo-${todo.status}`} key={todo.id}>
                  <Icon className={todo.status === "in_progress" ? "spin" : undefined} size={14} />
                  <span>{todo.content}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="work-capsule-empty">还没有任务清单，计划正文在对话里。</p>
        )}
      </div>
    </details>
  );
}
