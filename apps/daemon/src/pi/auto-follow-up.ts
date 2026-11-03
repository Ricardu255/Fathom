import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@harness/core";

/** 只有显式要求自主迭代时，模型才会在未完成时输出这一行标记。 */
export const AUTO_FOLLOW_UP_MARKER = "<!-- FATHOM_CONTINUE -->";

export const AUTO_FOLLOW_UP_SYSTEM_INSTRUCTION = `When the user explicitly requests autonomous iteration across multiple model turns, perform exactly one iteration in each response. If another turn is required, end with the exact standalone line ${AUTO_FOLLOW_UP_MARKER}. The harness starts that next turn automatically; do not explain or mention this marker. Do not emit this marker when the task is complete or for ordinary responses.`;

/** 边界续轮需要一条隐藏的 user 消息，provider 才会发起下一次请求。 */
export const AUTO_FOLLOW_UP_PROMPT = `Continue the autonomous task from the previous assistant response. Treat its latest state or result as the input to this turn and perform exactly one next iteration. If another iteration is still required, end with the exact standalone line ${AUTO_FOLLOW_UP_MARKER}. Otherwise, finish without that marker.`;

/**
 * 续轮由 pi 的 agent_before_settle 边界执行，而不是在 message_end 里注入隐藏用户消息。
 * 模型仍用标记表达“还需要一轮”，边界负责把它变成一个可审计的 continuation。
 */
export function createAutoFollowUpExtension(shouldContinue: () => boolean): InlineExtension {
  return {
    factory: (pi) => {
      pi.on("agent_before_settle", (event) => {
        // 事件里的 canContinue 描述的是追加 entries 之前的上下文；真正能否续轮
        // 由 pi 在提交 custom_message 之后重新计算，所以这里不能提前返回。
        if (!shouldContinue()) return undefined;
        return {
          continue: true,
          entries: [
            {
              content: AUTO_FOLLOW_UP_PROMPT,
              customType: "fathom-auto-follow-up",
              display: false,
              type: "custom_message",
            },
          ],
        };
      });
    },
    hidden: true,
    name: "fathom-auto-follow-up",
  };
}

export function requestsAutoFollowUp(message: unknown): boolean {
  return lastText(message)?.trimEnd().endsWith(AUTO_FOLLOW_UP_MARKER) === true;
}

export function stripAutoFollowUpMarker(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed === AUTO_FOLLOW_UP_MARKER) return "";
  const markerLine = `\n${AUTO_FOLLOW_UP_MARKER}`;
  return trimmed.endsWith(markerLine) ? trimmed.slice(0, -markerLine.length).trimEnd() : text;
}

export function stripMarkerFromMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === "text" ? { ...block, text: stripAutoFollowUpMarker(block.text) } : block,
    ),
  };
}

function lastText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}
