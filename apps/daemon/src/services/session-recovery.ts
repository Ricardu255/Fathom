import { type HarnessEvent, HarnessEventType } from "@harness/core";

export interface RecoveryEventDraft {
  data: unknown;
  runId: string | null;
  type: HarnessEventType;
}

/**
 * 根据 JSONL 事实源找出重启时仍未结束的审批、用户提问、子 Agent 与 Run，
 * 生成幂等的补偿终态。已结束的 Session 返回空数组。
 */
export function planSessionRecovery(events: readonly HarnessEvent[]): RecoveryEventDraft[] {
  const pendingApprovals = new Map<string, { executionId?: string; runId: string | null }>();
  const pendingUserInputs = new Map<string, { executionId?: string; runId: string | null }>();
  const activeExecutions = new Map<string, string | null>();
  const activeRuns = new Set<string>();

  for (const event of events) {
    const data = asRecord(event.data);
    if (event.type === HarnessEventType.RUN_STARTED && event.runId !== null) {
      activeRuns.add(event.runId);
    } else if (
      event.type === HarnessEventType.RUN_COMPLETED ||
      event.type === HarnessEventType.RUN_FAILED ||
      event.type === HarnessEventType.RUN_ABORTED
    ) {
      if (event.runId !== null) activeRuns.delete(event.runId);
    } else if (
      event.type === HarnessEventType.SUBAGENT_QUEUED ||
      event.type === HarnessEventType.SUBAGENT_STARTED
    ) {
      const executionId = readString(data, "executionId");
      if (executionId !== null) activeExecutions.set(executionId, event.runId);
    } else if (
      event.type === HarnessEventType.SUBAGENT_COMPLETED ||
      event.type === HarnessEventType.SUBAGENT_FAILED ||
      event.type === HarnessEventType.SUBAGENT_ABORTED
    ) {
      const executionId = readString(data, "executionId");
      if (executionId !== null) activeExecutions.delete(executionId);
    } else if (event.type === HarnessEventType.APPROVAL_REQUESTED) {
      const approvalId = readString(data, "approvalId");
      if (approvalId !== null) {
        const executionId = readString(data, "executionId");
        pendingApprovals.set(approvalId, {
          ...(executionId === null ? {} : { executionId }),
          runId: event.runId,
        });
      }
    } else if (event.type === HarnessEventType.APPROVAL_RESOLVED) {
      const approvalId = readString(data, "approvalId");
      if (approvalId !== null) pendingApprovals.delete(approvalId);
    } else if (event.type === HarnessEventType.INPUT_REQUESTED) {
      const inputId = readString(data, "inputId");
      if (inputId !== null) {
        const executionId = readString(data, "executionId");
        pendingUserInputs.set(inputId, {
          ...(executionId === null ? {} : { executionId }),
          runId: event.runId,
        });
      }
    } else if (
      event.type === HarnessEventType.INPUT_RESOLVED ||
      event.type === HarnessEventType.INPUT_EXPIRED
    ) {
      const inputId = readString(data, "inputId");
      if (inputId !== null) pendingUserInputs.delete(inputId);
    }
  }

  const drafts: RecoveryEventDraft[] = [];
  for (const [approvalId, approval] of pendingApprovals) {
    drafts.push({
      data: {
        approvalId,
        decision: "denied",
        ...(approval.executionId === undefined ? {} : { executionId: approval.executionId }),
      },
      runId: approval.runId,
      type: HarnessEventType.APPROVAL_RESOLVED,
    });
  }
  for (const [inputId, input] of pendingUserInputs) {
    drafts.push({
      data: {
        ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
        inputId,
        reason: "aborted",
      },
      runId: input.runId,
      type: HarnessEventType.INPUT_EXPIRED,
    });
  }
  for (const [executionId, runId] of activeExecutions) {
    drafts.push({
      data: {
        errorCode: "SUBAGENT_INTERRUPTED",
        executionId,
        parentExecutionId: null,
        resultSummary: "daemon 重启导致子 Agent 中断",
      },
      runId,
      type: HarnessEventType.SUBAGENT_ABORTED,
    });
  }
  for (const runId of activeRuns) {
    drafts.push({
      data: { code: "DAEMON_RESTART", message: "daemon 重启导致 Run 中断" },
      runId,
      type: HarnessEventType.RUN_ABORTED,
    });
  }
  return drafts;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item !== "" ? item : null;
}
