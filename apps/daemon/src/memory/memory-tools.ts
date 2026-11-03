import type { Tool, ToolResult } from "@harness/core";
import { z } from "zod";
import type { MemoryService } from "./memory-service";

const saveSchema = z.object({
  content: z.string().min(1).max(2_000),
  title: z.string().min(1).max(120).optional(),
});

const searchSchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  query: z.string().min(1).max(500),
});

const forgetSchema = z.object({
  id: z.string().min(1).max(100),
});

export function createMemoryTools(memory: MemoryService): Tool[] {
  return [saveMemoryTool(memory), searchMemoryTool(memory), forgetMemoryTool(memory)];
}

function saveMemoryTool(memory: MemoryService): Tool {
  return {
    description:
      "保存一条值得跨会话复用的长期记忆，例如用户偏好、项目约束、稳定事实。不要保存临时聊天内容或敏感凭据。",
    async execute(input): Promise<ToolResult> {
      const parsed = saveSchema.parse(input);
      const saved = await memory.create(parsed);
      return { content: `已保存记忆 ${saved.id}：${saved.title}` };
    },
    inputSchema: toJsonSchema(saveSchema),
    name: "save_memory",
    parse: (input) => saveSchema.parse(input),
    requiresApproval: true,
    summarize: (input) => {
      const parsed = saveSchema.parse(input);
      return `保存长期记忆：${parsed.title ?? parsed.content.slice(0, 40)}`;
    },
  };
}

function searchMemoryTool(memory: MemoryService): Tool {
  return {
    description:
      "按关键词检索长期记忆。记忆是跨会话保存的稳定事实与偏好，不是文献全文；需要论文内容时使用 search_knowledge。",
    async execute(input): Promise<ToolResult> {
      const parsed = searchSchema.parse(input);
      const hits = await memory.search(parsed.query, parsed.limit ?? 5);
      if (hits.length === 0) return { content: "没有匹配的长期记忆。" };
      return {
        content: hits
          .map(
            (hit, index) =>
              `${index + 1}. [${hit.documentTitle}] ${hit.content}\n   id: ${hit.documentId.replace(/^memory:/u, "")}`,
          )
          .join("\n"),
      };
    },
    inputSchema: toJsonSchema(searchSchema),
    name: "search_memory",
    parse: (input) => searchSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => {
      const parsed = searchSchema.parse(input);
      return `检索长期记忆：${parsed.query}`;
    },
  };
}

function forgetMemoryTool(memory: MemoryService): Tool {
  return {
    description: "删除一条不再准确的长期记忆。只在用户明确要求或事实已确认失效时使用。",
    async execute(input): Promise<ToolResult> {
      const parsed = forgetSchema.parse(input);
      memory.delete(parsed.id);
      return { content: `已删除记忆 ${parsed.id}。` };
    },
    inputSchema: toJsonSchema(forgetSchema),
    name: "forget_memory",
    parse: (input) => forgetSchema.parse(input),
    requiresApproval: true,
    summarize: (input) => {
      const parsed = forgetSchema.parse(input);
      return `删除长期记忆 ${parsed.id}`;
    },
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
