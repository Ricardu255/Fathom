import type { HarnessEvent, Tool, ToolContext, ToolResult } from "@harness/core";
import { z } from "zod";
import {
  formatSessionHistoryHits,
  type SessionHistoryHit,
  searchSessionHistory,
} from "../services/session-history";

const searchHistorySchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  query: z.string().min(1).max(500),
});

export function createSessionHistoryTool(readEvents: () => Promise<readonly HarnessEvent[]>): Tool {
  return {
    description:
      "在当前 Session 的完整 JSONL 历史中检索关键词，返回有界片段、可见消息序号与事件 seq。适合找回之前说过的话、文件路径、命令输出或失败的测试。只读，不修改任何内容。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = searchHistorySchema.parse(input);
      context.signal.throwIfAborted();
      const hits: SessionHistoryHit[] = searchSessionHistory(
        await readEvents(),
        parsed.query,
        parsed.limit,
      );
      return { content: formatSessionHistoryHits(hits) };
    },
    inputSchema: toJsonSchema(searchHistorySchema),
    name: "search_history",
    parse: (input) => searchHistorySchema.parse(input),
    requiresApproval: false,
    summarize: (input) => {
      const parsed = searchHistorySchema.parse(input);
      return `检索会话历史：${parsed.query.slice(0, 80)}`;
    },
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
