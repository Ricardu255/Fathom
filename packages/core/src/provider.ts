import type { Usage } from "./events";
import type { AgentMessage, ContentBlock } from "./messages";

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

export interface ModelRequest {
  maxTokens: number;
  messages: readonly AgentMessage[];
  model: string;
  signal: AbortSignal;
  system: string;
  tools: readonly ToolDefinition[];
}

export interface ModelResult {
  content: ContentBlock[];
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "other";
  usage?: Usage;
}

export interface ModelClient {
  stream(request: ModelRequest, onTextDelta: (text: string) => void): Promise<ModelResult>;
}
