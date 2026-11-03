import type { RequestSnapshotData, RequestSnapshotTool } from "@harness/core";

const MAX_MESSAGES = 200;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_STRING_CHARS = 8_000;
const MAX_ARRAY_ITEMS = 200;
const MAX_TOOL_DESCRIPTION_CHARS = 2_000;

export interface RequestSnapshotInput {
  messages: unknown;
  model: string;
  requestIndex: number;
  /** 与上一份快照相同则不再重复写入，避免长会话里同一份 System Prompt 存几十遍。 */
  reuseSystemPrompt?: boolean;
  reuseTools?: boolean;
  runId: string | null;
  systemPrompt: string;
  tools: readonly RequestSnapshotTool[];
}

/**
 * 生成有界的请求级 Context 快照：保留 system prompt、工具定义与消息数组，
 * 去掉 base64 图片、截断超长文本，并在超过总量预算时丢弃最旧消息。
 * System Prompt 与工具定义在未变化时只写标记，不重复写正文。
 */
export function buildRequestSnapshot(input: RequestSnapshotInput): RequestSnapshotData {
  const source = Array.isArray(input.messages) ? input.messages : [input.messages];
  let messages = source.slice(-MAX_MESSAGES).map((message) => sanitize(message, 0));
  let truncated = source.length > messages.length;

  while (messages.length > 1 && roughBytes(messages) > MAX_SNAPSHOT_BYTES) {
    messages = messages.slice(1);
    truncated = true;
  }

  const tools = input.tools.map((tool) => ({
    description: truncate(tool.description, MAX_TOOL_DESCRIPTION_CHARS),
    inputSchema: sanitize(tool.inputSchema, 0),
    name: tool.name,
  }));
  const systemPrompt = truncate(input.systemPrompt, 32_000);
  // token 估算要按完整内容算，否则复用时会把输入算少。
  const estimatedInputTokens = Math.ceil(roughBytes({ messages, systemPrompt, tools }) / 3);
  const reuseSystemPrompt = input.reuseSystemPrompt === true;
  const reuseTools = input.reuseTools === true;
  return {
    estimatedInputTokens,
    messages,
    model: input.model,
    requestIndex: input.requestIndex,
    runId: input.runId,
    systemPrompt: reuseSystemPrompt ? "" : systemPrompt,
    ...(reuseSystemPrompt ? { systemPromptUnchanged: true } : {}),
    tools: reuseTools ? [] : tools,
    ...(reuseTools ? { toolsUnchanged: true } : {}),
    truncated,
  };
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > 8) return "[max depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clipText(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS)
      items.push(`[${value.length - MAX_ARRAY_ITEMS} items omitted]`);
    return items;
  }
  if (typeof value !== "object") return "[unsupported]";

  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    return {
      data: `[base64 omitted: ${record.data.length} chars]`,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      type: "image",
    };
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    result[key] =
      key === "data" && typeof item === "string" && item.length > 10_000
        ? `[base64 omitted: ${item.length} chars]`
        : sanitize(item, depth + 1);
  }
  return result;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`
    : value;
}

/**
 * 长文本保留首尾。工具输出往往开头是摘要、末尾才是错误行或结论，
 * 只截前面会把最该看的部分丢掉。
 */
function clipText(value: string, maxChars = MAX_STRING_CHARS): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${value.slice(0, head)}…[省略 ${value.length - maxChars} 字符]…${value.slice(-tail)}`;
}

function roughBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}
