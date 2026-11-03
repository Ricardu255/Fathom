import type { Tool, ToolResult } from "@harness/core";
import { z } from "zod";

const searchKnowledgeSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().describe("返回片段数，默认 8"),
  query: z.string().min(1).max(500).describe("自然语言或关键词查询"),
});

/** 只读工具：从文献/知识库中检索带页码引用的片段。 */
export const searchKnowledgeTool: Tool = {
  description:
    "在已上传的文献与知识库中检索片段。结果包含文档标题、页码和章节，可直接作为回答依据；需要完整上下文时再读取原文献。",
  async execute(input, context): Promise<ToolResult> {
    if (context.searchKnowledge === undefined) {
      throw new Error("当前 Session 没有可用的知识库检索能力");
    }
    const parsed = searchKnowledgeSchema.parse(input);
    const hits = await context.searchKnowledge(parsed.query, parsed.limit ?? 8, context.signal);
    if (hits.length === 0) return { content: "(no matches)" };
    return {
      content: hits
        .map((hit, index) => {
          const pages =
            hit.pageStart === hit.pageEnd
              ? `p.${hit.pageStart}`
              : `p.${hit.pageStart}-${hit.pageEnd}`;
          const section = hit.section === null ? "" : ` · ${hit.section}`;
          return `[${index + 1}] ${hit.documentTitle} ${pages}${section}\n${hit.content.slice(0, 2_000)}`;
        })
        .join("\n\n"),
    };
  },
  inputSchema: toJsonSchema(searchKnowledgeSchema),
  name: "search_knowledge",
  parse: (input) => searchKnowledgeSchema.parse(input),
  requiresApproval: false,
  summarize: (input) => {
    const parsed = searchKnowledgeSchema.parse(input);
    return `检索知识库：${parsed.query}`;
  },
};

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
