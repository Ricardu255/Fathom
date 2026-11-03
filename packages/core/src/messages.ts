export interface TextBlock {
  text: string;
  type: "text";
}

export interface ToolUseBlock {
  id: string;
  input: unknown;
  name: string;
  type: "tool_use";
}

export interface ToolResultBlock {
  content: string;
  isError?: boolean;
  toolUseId: string;
  type: "tool_result";
}

export interface ThinkingBlock {
  text: string;
  type: "thinking";
}

export interface ImageBlock {
  data: string;
  mimeType: string;
  type: "image";
}

export interface MessageImage {
  data: string;
  mimeType: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface AgentMessage {
  content: ContentBlock[];
  role: "user" | "assistant";
  timestamp: number;
}

export function createUserMessage(text: string, timestamp = Date.now()): AgentMessage {
  return { content: [{ type: "text", text }], role: "user", timestamp };
}

export function createAssistantMessage(
  content: ContentBlock[],
  timestamp = Date.now(),
): AgentMessage {
  return { content, role: "assistant", timestamp };
}

export function createToolResultMessage(
  results: readonly ToolResultBlock[],
  timestamp = Date.now(),
): AgentMessage {
  return { content: [...results], role: "user", timestamp };
}

export function messageText(message: AgentMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

export function messageImages(message: AgentMessage): ImageBlock[] {
  return message.content.filter((block): block is ImageBlock => block.type === "image");
}

export function isToolResultOnlyMessage(message: AgentMessage): boolean {
  return (
    message.content.length > 0 && message.content.every((block) => block.type === "tool_result")
  );
}

export function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));
}

/**
 * 合并相邻同角色消息，并保证每个 assistant tool_use 都有紧随其后的 tool_result。
 * 中止或重启后残缺的工具调用会补一条错误结果，避免下一次模型请求被 API 拒绝。
 */
export function sanitizeToolPairing(messages: readonly AgentMessage[]): AgentMessage[] {
  const merged: AgentMessage[] = [];
  for (const message of cloneMessages(messages)) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push(message);
    }
  }

  if (merged[0]?.role === "assistant") {
    merged.unshift(createUserMessage("（继续上一次会话。）", merged[0].timestamp));
  }

  // 删除找不到对应 tool_use 的孤儿 tool_result（常见于压缩/分支后从中间切开的上下文）。
  for (let index = 0; index < merged.length; index += 1) {
    const message = merged[index];
    if (message?.role !== "user") continue;
    const previous = merged[index - 1];
    const validToolUseIds = new Set(
      previous?.role === "assistant"
        ? previous.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))
        : [],
    );
    const filtered = message.content.filter(
      (block) => block.type !== "tool_result" || validToolUseIds.has(block.toolUseId),
    );
    if (filtered.length === 0) {
      merged.splice(index, 1);
      index -= 1;
      continue;
    }
    if (filtered.length !== message.content.length) message.content = filtered;
  }

  for (let index = 0; index < merged.length; index += 1) {
    const message = merged[index];
    if (message?.role !== "assistant") continue;
    const toolUses = message.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) continue;

    let next = merged[index + 1];
    if (next?.role !== "user") {
      next = createToolResultMessage([], message.timestamp);
      merged.splice(index + 1, 0, next);
    }
    const present = new Set(
      next.content.flatMap((block) => (block.type === "tool_result" ? [block.toolUseId] : [])),
    );
    for (const toolUse of toolUses) {
      if (present.has(toolUse.id)) continue;
      next.content.push({
        content: "工具调用在返回结果前被中止。",
        isError: true,
        toolUseId: toolUse.id,
        type: "tool_result",
      });
    }
  }

  return merged;
}
