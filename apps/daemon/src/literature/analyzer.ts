import { createUserMessage, type LiteratureReport, type ModelClient } from "@harness/core";
import { z } from "zod";
import {
  LITERATURE_MAP_SYSTEM_PROMPT,
  LITERATURE_REDUCE_SYSTEM_PROMPT,
  LITERATURE_SYSTEM_PROMPT,
} from "../prompts";
import type { ChunkedDocument, LiteratureChunk } from "./chunker";

const MAP_TIMEOUT_MS = 120_000;
const REDUCE_TIMEOUT_MS = 180_000;
const MAX_MAP_JSON_CHARS = 8_000;

const pageNumbers = z.array(z.number().int().min(1)).max(50).default([]);
const evidence = z.string().max(1_000).default("");

export const LiteratureMapResultSchema = z.object({
  claims: z
    .array(z.object({ evidence, pages: pageNumbers, text: z.string().max(2_000).default("") }))
    .max(60)
    .default([]),
  experiments: z.array(z.string().max(2_000)).max(40).default([]),
  innovations: z
    .array(
      z.object({
        description: z.string().max(4_000).default(""),
        evidence,
        pages: pageNumbers,
        title: z.string().max(300).default(""),
      }),
    )
    .max(30)
    .default([]),
  keyPoints: z.array(z.string().max(2_000)).max(40).default([]),
  limitations: z.array(z.string().max(2_000)).max(40).default([]),
  methods: z.array(z.string().max(2_000)).max(40).default([]),
  steps: z
    .array(
      z.object({
        description: z.string().max(4_000).default(""),
        evidence,
        pages: pageNumbers,
        step: z.string().max(300).default(""),
      }),
    )
    .max(30)
    .default([]),
});

export type LiteratureMapResult = z.infer<typeof LiteratureMapResultSchema>;

export interface AnalyzeDocumentInput {
  chunked: ChunkedDocument;
  maxTokens: number;
  model: string;
  modelClient: ModelClient;
  onProgress: (stage: string, progress: number) => void;
  onWarning?: (message: string, details?: Record<string, unknown>) => void;
  pages: readonly string[];
  signal: AbortSignal;
}

/** 短文档单次抽取；长文档 map-reduce，最后统一补 meta 并交给引用校验。 */
export async function analyzeDocument(input: AnalyzeDocumentInput): Promise<LiteratureReport> {
  if (input.signal.aborted) throw abortError();
  if (input.chunked.chunks.length <= 1) {
    input.onProgress("analyzing", 25);
    const chunk = input.chunked.chunks[0];
    const text = chunk?.text ?? buildPageText(input.pages);
    const report = await callJson({
      maxTokens: input.maxTokens,
      model: input.model,
      modelClient: input.modelClient,
      prompt: `请分析下面这篇文献，输出规定结构的 JSON。\n\n${text}`,
      signal: input.signal,
      system: LITERATURE_SYSTEM_PROMPT,
      timeoutMs: REDUCE_TIMEOUT_MS,
      schema: LiteratureReportSchema,
    });
    return withMeta(report, input, 1, input.chunked.analyzedPages);
  }

  const chunkCount = input.chunked.chunks.length;
  const mapped: { chunk: LiteratureChunk; result: LiteratureMapResult }[] = [];
  for (const [index, chunk] of input.chunked.chunks.entries()) {
    if (input.signal.aborted) throw abortError();
    input.onProgress("mapping", 10 + Math.round((55 * index) / chunkCount));
    try {
      const result = await mapChunk(input, chunk, index, chunkCount);
      mapped.push({ chunk, result });
    } catch (error: unknown) {
      if (input.signal.aborted) throw error;
      input.onWarning?.("文献片段抽取失败，已跳过", {
        chunkId: chunk.id,
        error: error instanceof Error ? error.message : String(error),
        pageEnd: chunk.pageEnd,
        pageStart: chunk.pageStart,
      });
    }
  }
  if (mapped.length === 0) throw new Error("所有文献片段抽取都失败了");

  input.onProgress("reducing", 72);
  try {
    const report = await callJson({
      maxTokens: input.maxTokens,
      model: input.model,
      modelClient: input.modelClient,
      prompt: buildReducePrompt(input.chunked, mapped),
      signal: input.signal,
      system: LITERATURE_REDUCE_SYSTEM_PROMPT,
      timeoutMs: REDUCE_TIMEOUT_MS,
      schema: LiteratureReportSchema,
    });
    return withMeta(report, input, mapped.length, mapped.at(-1)?.chunk.pageEnd ?? 0);
  } catch (error: unknown) {
    if (input.signal.aborted) throw error;
    input.onWarning?.("文献汇总失败，使用片段结果回退", {
      error: error instanceof Error ? error.message : String(error),
    });
    return withMeta(
      fallbackReport(input.chunked, mapped),
      input,
      mapped.length,
      mapped.at(-1)?.chunk.pageEnd ?? 0,
    );
  }
}

async function mapChunk(
  input: AnalyzeDocumentInput,
  chunk: LiteratureChunk,
  index: number,
  total: number,
): Promise<LiteratureMapResult> {
  const section = chunk.section === null ? "未识别章节" : chunk.section;
  return callJson({
    maxTokens: Math.min(input.maxTokens, 4_000),
    model: input.model,
    modelClient: input.modelClient,
    prompt: `这是文献的第 ${index + 1}/${total} 个片段，章节：${section}，页码范围 ${chunk.pageStart}-${chunk.pageEnd}。\n\n${chunk.text}`,
    signal: input.signal,
    system: LITERATURE_MAP_SYSTEM_PROMPT,
    timeoutMs: MAP_TIMEOUT_MS,
    schema: LiteratureMapResultSchema,
  });
}

interface CallJsonInput<T extends z.ZodType> {
  maxTokens: number;
  model: string;
  modelClient: ModelClient;
  prompt: string;
  schema: T;
  signal: AbortSignal;
  system: string;
  timeoutMs: number;
}

async function callJson<T extends z.ZodType>(input: CallJsonInput<T>): Promise<z.output<T>> {
  if (input.signal.aborted) throw abortError();
  const result = await input.modelClient.stream(
    {
      maxTokens: input.maxTokens,
      messages: [createUserMessage(input.prompt)],
      model: input.model,
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]),
      system: input.system,
      tools: [],
    },
    () => undefined,
  );
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (text === "") throw new Error("模型没有返回分析结果");
  return input.schema.parse(extractJson(text)) as z.output<T>;
}

function buildReducePrompt(
  chunked: ChunkedDocument,
  mapped: readonly { chunk: LiteratureChunk; result: LiteratureMapResult }[],
): string {
  const outline = chunked.outline
    .map((entry) => `- p.${entry.page} [L${entry.level}] ${entry.title}`)
    .join("\n");
  const fragments = mapped.map(({ chunk, result }) => {
    const json = JSON.stringify(result);
    return `### 片段 ${chunk.index + 1}（p.${chunk.pageStart}-${chunk.pageEnd}，${chunk.section ?? "未识别章节"}）\n${
      json.length > MAX_MAP_JSON_CHARS ? `${json.slice(0, MAX_MAP_JSON_CHARS)}…` : json
    }`;
  });
  return [
    `文献共 ${chunked.analyzedPages} 页，已覆盖 ${chunked.analyzedPages} 页${
      chunked.truncated ? "（原文较长，只分析了前部分页面）" : ""
    }。`,
    "",
    "章节结构：",
    outline || "（未识别到章节标题）",
    "",
    "片段抽取结果：",
    ...fragments,
    "",
    "请汇总为最终 JSON 报告。",
  ].join("\n");
}

function fallbackReport(
  chunked: ChunkedDocument,
  mapped: readonly { chunk: LiteratureChunk; result: LiteratureMapResult }[],
): LiteratureReport {
  const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))];
  const firstPage = chunked.chunks[0]?.pageStart ?? 1;
  return {
    authors: [],
    contributions: unique(mapped.flatMap(({ result }) => result.keyPoints)).slice(0, 20),
    experiments: unique(mapped.flatMap(({ result }) => result.experiments)).slice(0, 20),
    innovations: mapped
      .flatMap(({ result }) => result.innovations)
      .slice(0, 20)
      .map((item) => ({ ...item, confidence: "low" as const })),
    keywords: [],
    knowledgeChecklist: mapped
      .flatMap(({ result }) =>
        result.claims.map((claim) => ({
          confidence: "low" as const,
          evidence: claim.evidence,
          importance: "medium" as const,
          item: claim.text,
          pages: claim.pages,
        })),
      )
      .slice(0, 60),
    limitations: unique(mapped.flatMap(({ result }) => result.limitations)).slice(0, 20),
    methods: unique(mapped.flatMap(({ result }) => result.methods)).slice(0, 20),
    researchQuestions: [],
    summary: `（自动回退汇总）共分析 ${chunked.analyzedPages} 页、${mapped.length} 个片段，部分条目缺少结构化汇总。`,
    technicalRoute: mapped
      .flatMap(({ result }) => result.steps)
      .slice(0, 20)
      .map((item) => ({ ...item, confidence: "low" as const })),
    title: `文献分析（p.${firstPage} 起）`,
  };
}

function withMeta(
  report: LiteratureReport,
  input: AnalyzeDocumentInput,
  chunkCount: number,
  analyzedPages: number,
): LiteratureReport {
  return {
    ...report,
    meta: {
      analyzedPages,
      chunkCount,
      generatedAt: Date.now(),
      model: input.model,
      outline: input.chunked.outline,
      truncated: input.chunked.truncated || analyzedPages < input.pages.length,
    },
  };
}

function buildPageText(pages: readonly string[]): string {
  return pages.map((page, index) => `--- page ${index + 1} ---\n${page}`).join("\n\n");
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型返回的内容不包含 JSON 对象");
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error("模型返回的 JSON 无法解析");
  }
}

function abortError(): Error {
  const error = new Error("Request was aborted");
  error.name = "AbortError";
  return error;
}

// 由 service 复用的报告 schema；导出避免重复定义。
export const LiteratureReportSchema = z.object({
  authors: z.array(z.string().max(200)).max(50).default([]),
  contributions: z.array(z.string().max(2_000)).max(50).default([]),
  experiments: z.array(z.string().max(2_000)).max(50).default([]),
  innovations: z
    .array(
      z.object({
        citationStatus: z.enum(["missing", "unverified", "verified"]).optional(),
        confidence: z.enum(["high", "low", "medium"]).optional(),
        description: z.string().max(4_000).default(""),
        evidence: evidence.optional(),
        pages: pageNumbers,
        title: z.string().max(300).default(""),
      }),
    )
    .max(30)
    .default([]),
  keywords: z.array(z.string().max(100)).max(50).default([]),
  knowledgeChecklist: z
    .array(
      z.object({
        citationStatus: z.enum(["missing", "unverified", "verified"]).optional(),
        confidence: z.enum(["high", "low", "medium"]).optional(),
        evidence: evidence.optional(),
        importance: z.enum(["high", "medium", "low"]).default("medium"),
        item: z.string().max(1_000).default(""),
        pages: pageNumbers,
      }),
    )
    .max(100)
    .default([]),
  limitations: z.array(z.string().max(2_000)).max(50).default([]),
  meta: z
    .object({
      analyzedPages: z.number().int().min(0),
      chunkCount: z.number().int().min(0),
      generatedAt: z.number(),
      model: z.string(),
      outline: z
        .array(z.object({ level: z.number().int(), page: z.number().int(), title: z.string() }))
        .default([]),
      truncated: z.boolean(),
    })
    .optional(),
  methods: z.array(z.string().max(2_000)).max(50).default([]),
  researchQuestions: z.array(z.string().max(2_000)).max(50).default([]),
  summary: z.string().max(8_000).default(""),
  technicalRoute: z
    .array(
      z.object({
        citationStatus: z.enum(["missing", "unverified", "verified"]).optional(),
        confidence: z.enum(["high", "low", "medium"]).optional(),
        description: z.string().max(4_000).default(""),
        evidence: evidence.optional(),
        pages: pageNumbers,
        step: z.string().max(300).default(""),
      }),
    )
    .max(30)
    .default([]),
  title: z.string().min(1).max(300),
});
