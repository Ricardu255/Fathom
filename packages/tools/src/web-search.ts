import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

const searchSchema = z.object({
  language: z.string().min(2).max(16).optional(),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
  query: z.string().min(1).max(500),
});

export interface WebSearchOptions {
  networkCheck?: (hostname: string) => string | undefined;
  searxngUrl?: string | undefined;
}

interface SearxngResult {
  abstract?: unknown;
  content?: unknown;
  snippet?: unknown;
  title?: unknown;
  url?: unknown;
}

export function createWebSearchTool(options: WebSearchOptions): Tool {
  return {
    description:
      "通过本机或自建 SearXNG 搜索公开网页，返回标题、URL 与摘要。需要配置 HARNESS_SEARXNG_URL；只返回搜索结果，不抓取正文（正文用 web_fetch）。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = searchSchema.parse(input);
      context.signal.throwIfAborted();
      const searxngUrl = options.searxngUrl?.trim();
      if (searxngUrl === undefined || searxngUrl === "") {
        return {
          content:
            "web_search 未配置搜索服务。请设置 HARNESS_SEARXNG_URL 指向本机或自建 SearXNG 的根地址，或改用 web_fetch。",
          isError: true,
        };
      }
      const results = await searchSearxng(searxngUrl, parsed, context.signal, options.networkCheck);
      if (results.length === 0) return { content: `没有找到与「${parsed.query}」相关的结果。` };
      return {
        content: results
          .map(
            (result, index) =>
              `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.content || "（无摘要）"}`,
          )
          .join("\n\n"),
      };
    },
    inputSchema: toJsonSchema(searchSchema),
    name: "web_search",
    parse: (input) => searchSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `搜索网页：${searchSchema.parse(input).query}`,
  };
}

async function searchSearxng(
  baseUrl: string,
  input: z.output<typeof searchSchema>,
  signal: AbortSignal,
  networkCheck: ((hostname: string) => string | undefined) | undefined,
): Promise<Array<{ content: string; title: string; url: string }>> {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("HARNESS_SEARXNG_URL 不是有效 URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("SearXNG 地址必须是 http/https");
  }
  const blocked = networkCheck?.(base.hostname);
  if (blocked !== undefined) throw new Error(blocked);
  const endpoint = new URL("search", base.href.endsWith("/") ? base.href : `${base.href}/`);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("q", input.query);
  endpoint.searchParams.set("safesearch", "1");
  endpoint.searchParams.set("limit", String(input.limit));
  if (input.language !== undefined) endpoint.searchParams.set("language", input.language);

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    credentials: "omit",
    headers: { accept: "application/json", "user-agent": "Fathom/0.1 (+local agent)" },
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const text = await readBounded(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("SearXNG 返回的不是有效 JSON；请确认 format=json 已启用");
  }
  const results =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { results?: unknown }).results)
      ? ((body as { results: SearxngResult[] }).results ?? [])
      : [];
  return results
    .flatMap((result) => {
      if (typeof result.url !== "string" || typeof result.title !== "string") return [];
      const content = [result.content, result.abstract, result.snippet].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      return [
        {
          content: (content ?? "").replace(/\s+/gu, " ").trim().slice(0, 500),
          title: result.title.trim().slice(0, 300),
          url: result.url,
        },
      ];
    })
    .slice(0, input.limit);
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      const remaining = MAX_RESPONSE_BYTES - bytes;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (bytes >= MAX_RESPONSE_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
