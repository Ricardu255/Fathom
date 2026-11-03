import type { ModelClient, ModelRequest, ModelResult } from "@harness/core";

const LITERATURE_MARKER = "[[LITERATURE_REPORT]]";
const LITERATURE_MAP_MARKER = "[[LITERATURE_MAP]]";
const LITERATURE_REDUCE_MARKER = "[[LITERATURE_REDUCE]]";

/**
 * 无 API Key 时的本地演示模型：
 * - 第一次提到“列出文件”会真实调用 list_files，演示工具循环；
 * - 文献解析请求返回一份固定结构的 JSON，方便先跑通 UI；
 * - 其余请求回显提示并流式输出一段说明。
 */
export class MockModelClient implements ModelClient {
  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const lastText =
      lastUser?.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n") ?? "";
    const hasToolResult = request.messages
      .at(-1)
      ?.content.some((block) => block.type === "tool_result");
    const hasCalledTool = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_use"),
    );

    if (request.system.includes(LITERATURE_MAP_MARKER)) {
      const text = buildMockMapResult();
      await streamText(onTextDelta, text, request.signal);
      return {
        content: [{ text, type: "text" }],
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 500 },
      };
    }

    if (
      request.system.includes(LITERATURE_REDUCE_MARKER) ||
      request.system.includes(LITERATURE_MARKER)
    ) {
      const text = buildMockLiteratureReport(lastText);
      await streamText(onTextDelta, text, request.signal);
      return {
        content: [{ text, type: "text" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1200, outputTokens: 800 },
      };
    }

    if (
      !hasToolResult &&
      !hasCalledTool &&
      /(检索|搜索|search).{0,12}(文献|知识库|knowledge)/iu.test(lastText) &&
      request.tools.some((tool) => tool.name === "search_knowledge")
    ) {
      const rawQuery = /(?:检索|搜索|search)\s*[:：]?\s*(.{1,40})/iu.exec(lastText)?.[1];
      const query =
        rawQuery?.replace(/^(?:文献|知识库|knowledge)\s*[:：]?\s*/iu, "").trim() || "pipeline";
      onTextDelta("我先在知识库里检索相关片段。\n\n");
      return {
        content: [
          {
            id: `mock-search-${Date.now()}`,
            input: { limit: 5, query },
            name: "search_knowledge",
            type: "tool_use",
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 420, outputTokens: 40 },
      };
    }

    if (
      !hasToolResult &&
      !hasCalledTool &&
      /(创建|写入|write).{0,12}(文件|file)/iu.test(lastText) &&
      request.tools.some((tool) => tool.name === "write_file")
    ) {
      onTextDelta("我先创建一个示例文件，需要你批准这次写入。\n\n");
      return {
        content: [
          {
            id: `mock-write-${Date.now()}`,
            input: { content: "Hello from the mock agent.\n", path: "mock-demo.txt" },
            name: "write_file",
            type: "tool_use",
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 420, outputTokens: 40 },
      };
    }

    if (
      !hasToolResult &&
      !hasCalledTool &&
      /(列出|查看|list).{0,12}(文件|目录|files?|directories)/iu.test(lastText) &&
      request.tools.some((tool) => tool.name === "list_files")
    ) {
      onTextDelta("我先看一下工作区里有什么文件。\n\n");
      return {
        content: [
          { id: `mock-${Date.now()}`, input: { path: "." }, name: "list_files", type: "tool_use" },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 400, outputTokens: 30 },
      };
    }

    const text = [
      "## Mock 模式已连通",
      "",
      "当前没有配置 `ANTHROPIC_API_KEY`，所以由本地 Mock 模型回复。你可以在 `.env` 中设置：",
      "",
      "```bash",
      "ANTHROPIC_API_KEY=sk-ant-...",
      "HARNESS_MOCK_MODEL=0",
      "ANTHROPIC_MODEL=claude-sonnet-5-5",
      "```",
      "",
      "然后重启 daemon，就会走真实的 Anthropic 流式接口。",
      "",
      "你可以试试：**列出当前工作区的文件**。这会触发一次真实的工具调用与结果回填。",
      "",
      `> 你刚才说：${lastText.slice(0, 300) || "（空消息）"}`,
    ].join("\n");
    await streamText(onTextDelta, text, request.signal);
    return {
      content: [{ text, type: "text" }],
      stopReason: "end_turn",
      usage: { inputTokens: 320, outputTokens: 180 },
    };
  }
}

function buildMockMapResult(): string {
  return JSON.stringify(
    {
      claims: [
        { evidence: "", pages: [1], text: "文档提出了一个分阶段处理流程。" },
        { evidence: "", pages: [2], text: "实验对比了三个基线方法。" },
      ],
      experiments: ["与 3 个基线方法对比"],
      innovations: [
        {
          description: "显式保存中间证据，便于追溯。",
          evidence: "",
          pages: [1],
          title: "证据回填",
        },
      ],
      keyPoints: ["分阶段处理", "显式证据", "基线对比"],
      limitations: ["仅在单一数据集上验证"],
      methods: ["文档分块", "结构化抽取"],
      steps: [
        { description: "解析 PDF 并保留页码。", evidence: "", pages: [1], step: "文档解析" },
        { description: "按片段抽取结构化信息。", evidence: "", pages: [2], step: "结构化抽取" },
      ],
    },
    null,
    2,
  );
}

function buildMockLiteratureReport(_input: string): string {
  return JSON.stringify(
    {
      authors: ["Mock Author"],
      contributions: ["提出一个可复现的实验框架", "在公开数据集上验证了方法的有效性"],
      experiments: ["与 3 个基线方法对比", "消融实验验证关键模块"],
      innovations: [
        {
          description: "把问题拆成检索、推理与验证三个阶段，并显式保存中间证据。",
          pages: [2, 3],
          title: "分阶段推理与证据回填",
        },
      ],
      keywords: ["mock", "literature", "agent"],
      knowledgeChecklist: [
        { importance: "high", item: "核心问题与研究动机", pages: [1] },
        { importance: "high", item: "方法的关键假设", pages: [2, 4] },
        { importance: "medium", item: "实验设置与评价指标", pages: [5] },
        { importance: "low", item: "未来工作", pages: [8] },
      ],
      limitations: ["仅在单一数据集上验证", "未讨论推理成本"],
      methods: ["文档分块", "结构化抽取", "模型评审"],
      researchQuestions: ["如何把长文档压缩成可执行的知识清单？"],
      summary:
        "这是 Mock 模型生成的示例报告。配置真实 API Key 后，系统会基于 PDF 正文逐页抽取摘要、技术路线与创新点。",
      technicalRoute: [
        { description: "解析 PDF 并按页保留引用。", pages: [1], step: "文档解析" },
        { description: "按章节与语义块抽取方法、实验和结论。", pages: [2, 3], step: "结构化抽取" },
        { description: "聚合为知识清单、技术路线与创新点。", pages: [4, 5], step: "知识组织" },
      ],
      title: "Mock 文献解析报告",
    },
    null,
    2,
  );
}

async function streamText(
  onTextDelta: (text: string) => void,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const chunks = text.match(/[\s\S]{1,24}/gu) ?? [];
  for (const chunk of chunks) {
    if (signal.aborted) {
      const error = new Error("Request was aborted");
      error.name = "AbortError";
      throw error;
    }
    onTextDelta(chunk);
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
}
