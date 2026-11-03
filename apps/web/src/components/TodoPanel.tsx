import type { TodoItem } from "@harness/core";
import { Ban, CheckCircle2, Circle, ListChecks, Loader2 } from "lucide-react";

const STATUS_ICON = {
  blocked: Ban,
  completed: CheckCircle2,
  in_progress: Loader2,
  pending: Circle,
} as const;

export function TodoPanel({ todos }: { todos: readonly TodoItem[] }) {
  if (todos.length === 0) return null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return (
    <details className="todo-panel" open>
      <summary>
        <ListChecks size={15} />
        <span>任务清单</span>
        <span className="todo-count">
          {completed}/{todos.length}
        </span>
      </summary>
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
    </details>
  );
}
