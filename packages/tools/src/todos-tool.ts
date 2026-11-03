import type { TodoItem, Tool, ToolResult } from "@harness/core";
import { TodoStatus } from "@harness/core";
import { z } from "zod";

const updateTodosSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).max(500),
        id: z.string().min(1).max(100).optional(),
        status: z.enum([
          TodoStatus.PENDING,
          TodoStatus.IN_PROGRESS,
          TodoStatus.COMPLETED,
          TodoStatus.BLOCKED,
        ]),
      }),
    )
    .min(1)
    .max(30),
});

/** 让模型把多步任务显式写下来；事件持久化后由 UI 投影。 */
export const updateTodosTool: Tool = {
  description:
    "创建或更新当前任务清单。多步任务开始时先列出待办，执行中更新状态；完成一项就标记 completed。",
  async execute(input): Promise<ToolResult> {
    const parsed = updateTodosSchema.parse(input);
    const todos: TodoItem[] = parsed.todos.map((item, index) => ({
      content: item.content,
      id: item.id ?? `todo-${index + 1}`,
      status: item.status,
    }));
    const summary = todos
      .map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`)
      .join("\n");
    return { content: `当前任务清单：\n${summary}`, todos };
  },
  inputSchema: toJsonSchema(updateTodosSchema),
  name: "update_todos",
  parse: (input) => updateTodosSchema.parse(input),
  requiresApproval: false,
  summarize: (input) => {
    const parsed = updateTodosSchema.parse(input);
    return `更新任务清单（${parsed.todos.length} 项）`;
  },
};

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
