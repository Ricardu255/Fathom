import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { z } from "zod";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

const fetchSchema = z.object({
  maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).default(40_000),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  url: z.string().min(1).max(2_048),
});

export interface WebFetchOptions {
  /** 仅测试使用：允许访问回环/私网地址。 */
  allowPrivateNetwork?: boolean;
  /** 返回拒绝原因时阻止请求，用于沙箱域名边界。 */
  networkCheck?: (hostname: string) => string | undefined;
}

export type FetchAddressResolver = (hostname: string) => Promise<string[]>;

/** 只允许公开 HTTP(S) 地址；每一跳重定向都重新校验。 */
export async function assertPublicHttpUrl(
  input: string,
  options: { allowPrivateNetwork?: boolean; resolver?: FetchAddressResolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 http/https URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("URL 不能包含用户名或密码");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (options.allowPrivateNetwork !== true) throw new Error("拒绝访问本机地址");
    return url;
  }
  if (hostname.endsWith(".local") || hostname === "metadata.google.internal") {
    throw new Error("拒绝访问本地或元数据服务地址");
  }
  if (options.allowPrivateNetwork === true) return url;

  const addresses =
    isIP(hostname) !== 0 ? [hostname] : await resolveAddresses(hostname, options.resolver);
  if (addresses.length === 0) throw new Error("域名无法解析");
  if (addresses.some(isPrivateAddress)) throw new Error("拒绝访问私网、回环或保留地址");
  return url;
}

export function createWebFetchTool(options: WebFetchOptions = {}): Tool {
  return {
    description:
      "抓取公开 HTTP(S) 网页或接口，返回状态码、最终 URL、Content-Type 与有界文本。最多跟随 5 次重定向；拒绝私网/回环/元数据地址和二进制响应。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = fetchSchema.parse(input);
      context.signal.throwIfAborted();
      const timeout = AbortSignal.timeout(parsed.timeoutMs);
      const signal = AbortSignal.any([context.signal, timeout]);
      return { content: await fetchText(parsed.url, parsed.maxChars, signal, options) };
    },
    inputSchema: toJsonSchema(fetchSchema),
    name: "web_fetch",
    parse: (input) => fetchSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `抓取网页：${fetchSchema.parse(input).url}`,
  };
}

async function fetchText(
  input: string,
  maxChars: number,
  signal: AbortSignal,
  options: WebFetchOptions,
): Promise<string> {
  let current = input;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const url = await assertPublicHttpUrl(current, options);
    const blocked = options.networkCheck?.(url.hostname);
    if (blocked !== undefined) throw new Error(blocked);
    const response = await fetch(url, {
      credentials: "omit",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": "Fathom/0.1 (+local agent)",
      },
      redirect: "manual",
      signal,
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location === "") throw new Error("重定向缺少 Location");
      if (redirects === MAX_REDIRECTS) throw new Error(`重定向次数超过 ${MAX_REDIRECTS}`);
      current = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextContentType(contentType)) {
      throw new Error(`不支持的内容类型：${contentType || "未知"}（只返回文本类响应）`);
    }
    const body = await readBoundedBody(response, signal);
    const text = body.text.slice(0, maxChars);
    return [
      `URL: ${url.toString()}`,
      `状态: ${response.status} ${response.statusText}`.trim(),
      ...(contentType === "" ? [] : [`Content-Type: ${contentType}`]),
      ...(body.truncated || text.length < body.text.length ? ["[响应已截断]"] : []),
      "",
      text,
    ].join("\n");
  }
  throw new Error("重定向次数过多");
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = Buffer.from(value);
      const remaining = MAX_RESPONSE_BYTES - bytes;
      if (chunk.byteLength >= remaining) {
        chunks.push(chunk.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated: truncated || bytes >= MAX_RESPONSE_BYTES,
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isTextContentType(contentType: string): boolean {
  if (contentType === "") return true;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript") ||
    normalized.includes("x-www-form-urlencoded")
  );
}

async function resolveAddresses(
  hostname: string,
  resolver?: FetchAddressResolver,
): Promise<string[]> {
  if (resolver !== undefined) return resolver(hostname);
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true;
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return false;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
