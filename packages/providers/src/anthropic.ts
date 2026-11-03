import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentMessage,
  ContentBlock,
  ModelClient,
  ModelRequest,
  ModelResult,
} from "@harness/core";

export interface AnthropicModelClientOptions {
  apiKey: string;
}

/** 只做协议映射；循环、重试、审批和事件都由 @harness/core 持有。 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  public constructor(options: AnthropicModelClientOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    const stream = this.client.messages.stream(
      {
        max_tokens: request.maxTokens,
        messages: request.messages.map(toAnthropicMessage),
        model: request.model,
        system: request.system,
        tools: request.tools.map(toAnthropicTool),
      },
      { signal: request.signal },
    );
    stream.on("text", (text) => onTextDelta(text));
    const message = await stream.finalMessage();

    const content: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        content.push({ text: block.text, type: "text" });
      } else if (block.type === "tool_use") {
        content.push({ id: block.id, input: block.input, name: block.name, type: "tool_use" });
      }
    }

    return {
      content,
      stopReason: mapStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

function toAnthropicMessage(message: AgentMessage): Anthropic.Messages.MessageParam {
  return {
    content: message.content.map(toAnthropicBlock),
    role: message.role,
  };
}

function toAnthropicBlock(block: ContentBlock): Anthropic.Messages.ContentBlockParam {
  if (block.type === "text") return { text: block.text, type: "text" };
  if (block.type === "tool_use") {
    return {
      id: block.id,
      input: block.input as Record<string, unknown>,
      name: block.name,
      type: "tool_use",
    };
  }
  if (block.type === "image") {
    return {
      source: { data: block.data, media_type: block.mimeType, type: "base64" },
      type: "image",
    } as Anthropic.Messages.ContentBlockParam;
  }
  if (block.type === "thinking") {
    return { text: block.text, type: "text" } as Anthropic.Messages.ContentBlockParam;
  }
  return {
    content: block.content,
    ...(block.isError === true ? { is_error: true } : {}),
    tool_use_id: block.toolUseId,
    type: "tool_result",
  };
}

function toAnthropicTool(definition: {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}): Anthropic.Messages.Tool {
  return {
    description: definition.description,
    input_schema: definition.inputSchema as Anthropic.Messages.Tool["input_schema"],
    name: definition.name,
  };
}

function mapStopReason(
  reason: Anthropic.Messages.Message["stop_reason"],
): ModelResult["stopReason"] {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn") return "end_turn";
  return "other";
}
