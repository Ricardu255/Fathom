import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentMessage,
  type ContentBlock,
  type HarnessEvent,
  HarnessEventType,
  type MessageCompletedData,
  type RequestSnapshotData,
} from "@harness/core";
import { requestsAutoFollowUp, stripMarkerFromMessage } from "./auto-follow-up";

type PiAgentMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

export interface PiBridgeCallbacks {
  consumeInternalText?(text: string): boolean;
  consumeQueuedText(text: string): string | undefined;
  contextUsage?(): { limit: number; tokens: number } | null;
  compactionStats?(firstKeptEntryId: string): {
    replacedMessages: number;
    retainedFrom?: number;
  };
  onQueueUpdate(followUp: readonly string[]): void;
  onRequestSnapshot?(
    requestIndex: number,
  ): Promise<RequestSnapshotData | null> | RequestSnapshotData | null;
  onSettled?(): void;
}

export type PiBridgeEmit = (draft: {
  data: unknown;
  runId: string | null;
  type: HarnessEvent["type"];
}) => Promise<HarnessEvent>;

/**
 * 把 pi 的 AgentSessionEvent 投影成我们 Web/SSE 使用的事件协议。
 * pi 的 SessionManager 是模型上下文的事实源；这里的事件只用于 UI 与审计。
 */
export class PiEventBridge {
  private lastAssistantError: string | null = null;
  private promptPrefix: string | null = null;
  private runId: string | null = null;
  private steps = 0;
  private requestIndex = 0;

  public constructor(
    private readonly emit: PiBridgeEmit,
    private readonly callbacks: PiBridgeCallbacks,
    private readonly modelId: () => string,
    private readonly toolNames: () => readonly string[],
  ) {}

  public setRun(runId: string): void {
    this.runId = runId;
    this.lastAssistantError = null;
    this.promptPrefix = null;
    this.requestIndex = 0;
    this.steps = 0;
  }

  public setPromptPrefix(prefix: string | null): void {
    this.promptPrefix = prefix;
  }

  public clearRun(): void {
    this.promptPrefix = null;
    this.requestIndex = 0;
    this.runId = null;
  }

  public async handle(event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.lastAssistantError = null;
        this.steps = 0;
        await this.emit({
          data: { model: this.modelId(), tools: this.toolNames() },
          runId: this.runId,
          type: HarnessEventType.RUN_STARTED,
        });
        return;
      case "turn_start": {
        this.requestIndex += 1;
        let snapshot: RequestSnapshotData | null = null;
        try {
          snapshot = (await this.callbacks.onRequestSnapshot?.(this.requestIndex)) ?? null;
        } catch {
          // 快照失败不能中断真实 Run。
        }
        if (snapshot !== null) {
          await this.emit({
            data: snapshot,
            runId: this.runId,
            type: HarnessEventType.REQUEST_SNAPSHOT,
          });
        }
        return;
      }
      case "turn_end":
        this.steps += 1;
        return;
      case "message_end":
        await this.handleMessageEnd(event.message);
        return;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          if (delta) {
            await this.emit({
              data: { text: delta },
              runId: this.runId,
              type: HarnessEventType.TEXT_DELTA,
            });
          }
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          const delta = event.assistantMessageEvent.delta;
          if (delta) {
            await this.emit({
              data: { text: delta },
              runId: this.runId,
              type: HarnessEventType.REASONING_DELTA,
            });
          }
        }
        return;
      case "tool_execution_start":
        await this.emit({
          data: { input: event.args, toolCallId: event.toolCallId, toolName: event.toolName },
          runId: this.runId,
          type: HarnessEventType.TOOL_STARTED,
        });
        return;
      case "tool_execution_end": {
        const text = toolResultText(event.result);
        if (event.isError) {
          await this.emit({
            data: {
              error: text || "工具执行失败",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
            },
            runId: this.runId,
            type: HarnessEventType.TOOL_FAILED,
          });
        } else {
          await this.emit({
            data: { result: text, toolCallId: event.toolCallId, toolName: event.toolName },
            runId: this.runId,
            type: HarnessEventType.TOOL_COMPLETED,
          });
        }
        return;
      }
      case "compaction_start": {
        const usage = this.callbacks.contextUsage?.() ?? null;
        await this.emit({
          data: {
            estimatedTokens: usage?.tokens ?? 0,
            limit: usage?.limit ?? 0,
          },
          runId: this.runId,
          type: HarnessEventType.CONTEXT_COMPACTION_STARTED,
        });
        return;
      }
      case "compaction_end": {
        if (event.errorMessage !== undefined) this.lastAssistantError = event.errorMessage;
        const result = event.result;
        const stats =
          result === undefined
            ? undefined
            : this.callbacks.compactionStats?.(result.firstKeptEntryId);
        await this.emit({
          data: {
            afterTokens: result?.estimatedTokensAfter ?? 0,
            beforeTokens: result?.tokensBefore ?? 0,
            replacedMessages: stats?.replacedMessages ?? 0,
            ...(stats?.retainedFrom === undefined ? {} : { retainedFrom: stats.retainedFrom }),
            summary: result?.summary ?? "",
          },
          runId: this.runId,
          type: HarnessEventType.CONTEXT_COMPACTED,
        });
        if (result?.usage !== undefined) {
          await this.emit({
            data: {
              inputTokens: result.usage.input,
              model: this.modelId(),
              outputTokens: result.usage.output,
            },
            runId: this.runId,
            type: HarnessEventType.USAGE,
          });
        }
        return;
      }
      case "auto_retry_start":
        await this.emit({
          data: {
            attempt: event.attempt,
            code: "AUTO_RETRY",
            delayMs: event.delayMs,
            maxAttempts: event.maxAttempts,
            message: event.errorMessage,
          },
          runId: this.runId,
          type: HarnessEventType.MODEL_RETRY,
        });
        return;
      case "auto_retry_end":
        if (!event.success) this.lastAssistantError = event.finalError ?? "自动重试失败";
        return;
      case "summarization_retry_scheduled":
        await this.emit({
          data: {
            attempt: event.attempt,
            code: "COMPACTION_RETRY",
            delayMs: event.delayMs,
            maxAttempts: event.maxAttempts,
            message: event.errorMessage,
          },
          runId: this.runId,
          type: HarnessEventType.MODEL_RETRY,
        });
        return;
      case "queue_update":
        this.callbacks.onQueueUpdate(event.followUp);
        return;
      case "agent_end":
        if (!event.willRetry && event.messages.length > 0) {
          const last = event.messages.at(-1);
          if (last?.role === "assistant" && last.stopReason === "error") {
            this.lastAssistantError = last.errorMessage ?? "模型请求失败";
          }
        }
        return;
      case "agent_settled":
        await this.finish(event.aborted);
        return;
      default:
        return;
    }
  }

  private stripPromptPrefix(message: AgentMessage): AgentMessage | null {
    const prefix = this.promptPrefix;
    if (prefix === null || prefix === "") return message;
    const blocks = message.content.flatMap((block) => {
      if (block.type !== "text" || !block.text.startsWith(prefix)) return [block];
      const text = block.text.slice(prefix.length).trimStart();
      return text === "" ? [] : [{ ...block, text }];
    });
    return blocks.length === 0 ? null : { ...message, content: blocks };
  }

  private async handleMessageEnd(piMessage: PiAgentMessage): Promise<void> {
    if (piMessage.role === "system") return;
    if (piMessage.role === "assistant") {
      if ((piMessage as AssistantMessage).stopReason === "error") {
        this.lastAssistantError = (piMessage as AssistantMessage).errorMessage ?? "模型请求失败";
      }
      const converted = toOurMessage(piMessage);
      if (converted === null) return;
      const wantsFollowUp = requestsAutoFollowUp(converted);
      const displayed = wantsFollowUp ? stripMarkerFromMessage(converted) : converted;
      if (!isEmptyAssistant(displayed)) {
        await this.emit({
          data: { message: displayed } satisfies MessageCompletedData,
          runId: this.runId,
          type: HarnessEventType.MESSAGE_COMPLETED,
        });
      }
      const assistant = piMessage as AssistantMessage;
      if (assistant.usage !== undefined) {
        await this.emit({
          data: {
            inputTokens: assistant.usage.input,
            model: assistant.model || this.modelId(),
            outputTokens: assistant.usage.output,
          },
          runId: this.runId,
          type: HarnessEventType.USAGE,
        });
      }
      return;
    }

    if (piMessage.role === "user") {
      const raw = toOurMessage(piMessage);
      if (raw === null) return;
      const internal = this.callbacks.consumeInternalText?.(textOfPiMessage(piMessage)) === true;
      const converted = this.stripPromptPrefix(raw);
      if (converted === null) return;
      if (internal) {
        await this.emit({
          data: { hidden: true, message: converted } satisfies MessageCompletedData,
          runId: this.runId,
          type: HarnessEventType.MESSAGE_COMPLETED,
        });
        return;
      }
      const queuedInputId = this.callbacks.consumeQueuedText(textOfPiMessage(piMessage));
      await this.emit({
        data: {
          message: converted,
          ...(queuedInputId === undefined ? {} : { queuedInputId }),
        } satisfies MessageCompletedData,
        runId: this.runId,
        type: HarnessEventType.MESSAGE_COMPLETED,
      });
      return;
    }

    if (piMessage.role === "toolResult") {
      const converted = toOurMessage(piMessage);
      if (converted === null) return;
      await this.emit({
        data: { hidden: true, message: converted } satisfies MessageCompletedData,
        runId: this.runId,
        type: HarnessEventType.MESSAGE_COMPLETED,
      });
    }
  }

  private async finish(aborted: boolean): Promise<void> {
    const runId = this.runId;
    if (runId === null) return;
    if (aborted) {
      await this.emit({ data: null, runId, type: HarnessEventType.RUN_ABORTED });
    } else if (this.lastAssistantError !== null) {
      await this.emit({
        data: { code: "PROVIDER", message: this.lastAssistantError },
        runId,
        type: HarnessEventType.RUN_FAILED,
      });
    } else {
      await this.emit({
        data: { steps: this.steps },
        runId,
        type: HarnessEventType.RUN_COMPLETED,
      });
    }
    this.clearRun();
    this.callbacks.onSettled?.();
  }
}

export function toOurMessage(message: PiAgentMessage): AgentMessage | null {
  const timestamp = message.timestamp ?? Date.now();
  if (message.role === "user") {
    const blocks: ContentBlock[] = [];
    const content =
      typeof message.content === "string"
        ? [{ text: message.content, type: "text" as const }]
        : message.content;
    for (const block of content) {
      if (block.type === "text") blocks.push({ text: block.text, type: "text" });
      else if (
        block.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        blocks.push({ data: block.data, mimeType: block.mimeType, type: "image" });
      }
    }
    if (blocks.length === 0) blocks.push({ text: "[空消息]", type: "text" });
    return { content: blocks, role: "user", timestamp };
  }
  if (message.role === "assistant") {
    const blocks: ContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") blocks.push({ text: block.text, type: "text" });
      else if (block.type === "thinking") {
        blocks.push({ text: block.thinking, type: "thinking" });
      } else if (block.type === "toolCall") {
        blocks.push({
          id: block.id,
          input: block.arguments,
          name: block.name,
          type: "tool_use",
        });
      }
    }
    return blocks.length === 0 ? null : { content: blocks, role: "assistant", timestamp };
  }
  if (message.role === "toolResult") {
    return {
      content: [
        {
          content: textOfPiMessage(message),
          ...(message.isError === true ? { isError: true } : {}),
          toolUseId: message.toolCallId,
          type: "tool_result",
        },
      ],
      role: "user",
      timestamp,
    };
  }
  return null;
}

function isEmptyAssistant(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.content.some((block) => block.type === "text" || block.type === "tool_use")
  );
}

function textBlocks(message: unknown): string[] {
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const candidate = block as { text?: unknown; type?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function textOfPiMessage(message: PiAgentMessage): string {
  const text = textBlocks(message).join("\n").trim();
  return text.length > 0 ? text : "[非文本内容]";
}

function toolResultText(result: unknown): string {
  if (result === null || typeof result !== "object" || !("content" in result)) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}
