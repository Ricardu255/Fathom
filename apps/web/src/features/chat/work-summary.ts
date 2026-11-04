import type { PlanCreatedData, TodoItem } from "@harness/core";

export interface WorkSummary {
  currentStep: string | null;
  hasWork: boolean;
  planActive: boolean;
  todoCompleted: number;
  todoTotal: number;
}

/**
 * 胶囊上只放一眼能看完的东西：计划有没有、任务进度、当前在做什么。
 * 当前项优先取进行中的任务，没有就取第一个还没完成的。
 */
export function summarizeWork(input: {
  plan: PlanCreatedData | null;
  todos: readonly TodoItem[];
}): WorkSummary {
  const todoTotal = input.todos.length;
  const todoCompleted = input.todos.filter((todo) => todo.status === "completed").length;
  const running = input.todos.find((todo) => todo.status === "in_progress");
  const next =
    input.todos.find((todo) => todo.status === "blocked") ??
    input.todos.find((todo) => todo.status === "pending");
  const planActive = input.plan !== null && input.plan.text.trim() !== "";
  return {
    currentStep: running?.content ?? next?.content ?? null,
    hasWork: planActive || todoTotal > 0,
    planActive,
    todoCompleted,
    todoTotal,
  };
}
