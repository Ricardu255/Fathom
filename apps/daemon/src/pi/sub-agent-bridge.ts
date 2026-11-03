import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentMessage,
  HarnessEventType,
  type SubAgentMessageData,
  type SubAgentTextDeltaData,
  type SubAgentToolFinishedData,
  type SubAgentToolStartedData,
} from "@harness/core";
import { type PiBridgeEmit, toOurMessage } from "./event-bridge";

/** 把子 Agent 的 pi 事件投影成带 executionId 的 subagent.* 事件。 */
export class SubAgentEventBridge {
  public constructor(
    private readonly emit: PiBridgeEmit,
    private readonly executionId: string,
    private readonly parentExecutionId: string | null,
    private readonly getRunId: () => string | null,
  ) {}

  public async handle(event: AgentSessionEvent): Promise<void> {
    switch (event.type) {
      case "message_end":
        await this.messageEnd(event.message);
        return;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          const text = event.assistantMessageEvent.delta;
          if (text) {
            await this.emit({
              data: { executionId: this.executionId, text } satisfies SubAgentTextDeltaData,
              runId: this.getRunId(),
              type: HarnessEventType.SUBAGENT_TEXT_DELTA,
            });
          }
        }
        return;
      case "tool_execution_start":
        await this.emit({
          data: {
            executionId: this.executionId,
            input: event.args,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          } satisfies SubAgentToolStartedData,
          runId: this.getRunId(),
          type: HarnessEventType.SUBAGENT_TOOL_STARTED,
        });
        return;
      case "tool_execution_end": {
        const text = toolResultText(event.result);
        await this.emit({
          data: {
            executionId: this.executionId,
            ...(event.isError ? { error: text || "工具执行失败" } : { result: text }),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          } satisfies SubAgentToolFinishedData,
          runId: this.getRunId(),
          type: event.isError
            ? HarnessEventType.SUBAGENT_TOOL_FAILED
            : HarnessEventType.SUBAGENT_TOOL_COMPLETED,
        });
        return;
      }
      default:
        return;
    }
  }

  private async messageEnd(message: Parameters<typeof toOurMessage>[0]): Promise<void> {
    if (message.role === "system") return;
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      if (assistant.stopReason === "error") {
        await this.emit({
          data: {
            executionId: this.executionId,
            parentExecutionId: this.parentExecutionId,
            message: {
              content: [
                {
                  text: `模型错误：${assistant.errorMessage ?? "未知错误"}`,
                  type: "text",
                },
              ],
              role: "assistant",
              timestamp: assistant.timestamp,
            },
          } satisfies SubAgentMessageData,
          runId: this.getRunId(),
          type: HarnessEventType.SUBAGENT_MESSAGE_COMPLETED,
        });
        return;
      }
    }
    const converted: AgentMessage | null = toOurMessage(message);
    if (converted === null) return;
    await this.emit({
      data: {
        executionId: this.executionId,
        message: converted,
        parentExecutionId: this.parentExecutionId,
      } satisfies SubAgentMessageData,
      runId: this.getRunId(),
      type: HarnessEventType.SUBAGENT_MESSAGE_COMPLETED,
    });
  }
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
