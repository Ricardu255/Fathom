import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { z } from "zod";
import type { UserInputCoordinator } from "../pi/user-input-coordinator";

const optionSchema = z.object({
  description: z.string().max(500).optional(),
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
});
const questionSchema = z.object({
  allowCustomInput: z.boolean().default(true),
  body: z.string().max(4_000).default(""),
  id: z.string().min(1).max(64),
  multiSelect: z.boolean().default(false),
  options: z.array(optionSchema).max(12).default([]),
  title: z.string().min(1).max(300),
});
const requestSchema = z.object({
  questions: z.array(questionSchema).min(1).max(8),
  timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
});

export function createUserInputTool(coordinator: UserInputCoordinator): Tool {
  return {
    description:
      "向用户提出一组需要人工决定的问题并等待回答。只有缺少目标、范围或关键决策时使用；提供最少的选项，推荐项放第一位。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = requestSchema.parse(input);
      const answers = await coordinator.request(
        {
          questions: parsed.questions.map((question) => ({
            allowCustomInput: question.allowCustomInput,
            body: question.body,
            id: question.id,
            multiSelect: question.multiSelect,
            options: question.options.map((option) => ({
              id: option.id,
              label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
            title: question.title,
          })),
          ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
        },
        context.signal,
      );
      return {
        content: answers.map((answer) => `${answer.questionId}: ${answer.value}`).join("\n"),
      };
    },
    inputSchema: toJsonSchema(requestSchema),
    name: "request_user_input",
    parse: (input) => requestSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => {
      const parsed = requestSchema.parse(input);
      return `向用户提问：${parsed.questions.map((question) => question.title).join("；")}`;
    },
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
