import { randomUUID } from "node:crypto";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import type { SessionEventStore } from "../storage/event-store";

/**
 * 将会话事件复制到新 Session，并关闭复制时仍未决的审批，避免新会话永久挂起。
 * 返回写入的最后一个 seq；没有事件时返回 0。
 */
export async function copySessionEvents(
  events: SessionEventStore,
  sourceSessionId: string,
  targetSessionId: string,
  maxSeq?: number,
): Promise<number> {
  const source = await events.read(sourceSessionId, 0);
  const pendingApprovals = new Map<string, HarnessEvent>();
  let seq = 0;

  const append = async (event: HarnessEvent): Promise<void> => {
    seq += 1;
    await events.append({
      ...event,
      id: randomUUID(),
      seq,
      sessionId: targetSessionId,
    });
  };

  for (const event of source) {
    if (maxSeq !== undefined && event.seq > maxSeq) break;
    const approvalId = approvalIdOf(event);
    if (event.type === HarnessEventType.APPROVAL_REQUESTED && approvalId !== null) {
      pendingApprovals.set(approvalId, event);
    } else if (event.type === HarnessEventType.APPROVAL_RESOLVED && approvalId !== null) {
      pendingApprovals.delete(approvalId);
    }
    await append(event);
  }

  for (const [approvalId, request] of pendingApprovals) {
    await append({
      data: { approvalId, decision: "denied" },
      id: randomUUID(),
      runId: request.runId,
      seq: 0,
      sessionId: targetSessionId,
      timestamp: Date.now(),
      type: HarnessEventType.APPROVAL_RESOLVED,
    });
  }

  return seq;
}

/** 找到指定用户消息时间戳对应的事件 seq，用于从历史消息 fork。 */
export function findUserMessageSeq(
  events: readonly HarnessEvent[],
  timestamp: number,
): number | null {
  let match: number | null = null;
  for (const event of events) {
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
    const message = (data as { message?: unknown }).message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const candidate = message as { role?: unknown; timestamp?: unknown };
    if (candidate.role === "user" && candidate.timestamp === timestamp) match = event.seq;
  }
  return match;
}

function approvalIdOf(event: HarnessEvent): string | null {
  if (
    event.type !== HarnessEventType.APPROVAL_REQUESTED &&
    event.type !== HarnessEventType.APPROVAL_RESOLVED
  ) {
    return null;
  }
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const approvalId = (data as { approvalId?: unknown }).approvalId;
  return typeof approvalId === "string" && approvalId !== "" ? approvalId : null;
}
