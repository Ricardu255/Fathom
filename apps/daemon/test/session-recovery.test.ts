import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { planSessionRecovery } from "../src/services/session-recovery";

function event(
  type: HarnessEvent["type"],
  data: unknown,
  seq: number,
  runId: string | null = "run-1",
): HarnessEvent {
  return {
    data,
    id: `event-${seq}`,
    runId,
    seq,
    sessionId: "session-1",
    timestamp: 1_000 + seq,
    type,
  };
}

test("恢复扫描为重启前未结束的审批/子 Agent/Run 生成补偿终态", () => {
  const drafts = planSessionRecovery([
    event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 1),
    event(
      HarnessEventType.SUBAGENT_QUEUED,
      { agentType: "worker", executionId: "exec-1", name: "worker-1", task: "任务" },
      2,
    ),
    event(
      HarnessEventType.SUBAGENT_STARTED,
      { agentType: "worker", executionId: "exec-1", name: "worker-1", task: "任务" },
      3,
    ),
    event(
      HarnessEventType.APPROVAL_REQUESTED,
      {
        approvalId: "approval-1",
        executionId: "exec-1",
        input: {},
        summary: "写入文件",
        toolCallId: "tool-1",
        toolName: "write_file",
      },
      4,
    ),
    event(HarnessEventType.RUN_COMPLETED, {}, 5, "run-finished"),
  ]);

  assert.equal(drafts.length, 3);
  assert.equal(drafts[0]?.type, HarnessEventType.APPROVAL_RESOLVED);
  assert.deepEqual(drafts[0]?.data, {
    approvalId: "approval-1",
    decision: "denied",
    executionId: "exec-1",
  });
  const second = drafts[1];
  const third = drafts[2];
  assert.ok(second !== undefined);
  assert.ok(third !== undefined);
  assert.equal(second.type, HarnessEventType.SUBAGENT_ABORTED);
  assert.equal((second.data as { errorCode?: string }).errorCode, "SUBAGENT_INTERRUPTED");
  assert.equal(third.type, HarnessEventType.RUN_ABORTED);
  assert.equal((third.data as { code?: string }).code, "DAEMON_RESTART");
});

test("已结束的 Run 不产生恢复事件；重复扫描幂等", () => {
  const events = [
    event(HarnessEventType.RUN_STARTED, {}, 1),
    event(
      HarnessEventType.SUBAGENT_STARTED,
      { agentType: "worker", executionId: "exec-1", name: "worker", task: "任务" },
      2,
    ),
    event(HarnessEventType.SUBAGENT_COMPLETED, { executionId: "exec-1", resultSummary: "完成" }, 3),
    event(HarnessEventType.RUN_COMPLETED, {}, 4),
  ];
  assert.deepEqual(planSessionRecovery(events), []);

  const recovered = [
    ...events,
    event(HarnessEventType.APPROVAL_RESOLVED, { approvalId: "approval-1", decision: "denied" }, 5),
    event(
      HarnessEventType.SUBAGENT_ABORTED,
      { executionId: "exec-2", errorCode: "SUBAGENT_INTERRUPTED" },
      6,
    ),
    event(HarnessEventType.RUN_ABORTED, { code: "DAEMON_RESTART" }, 7),
  ];
  assert.deepEqual(planSessionRecovery(recovered), []);
});

test("重启时为未决用户提问生成 aborted 过期事件", () => {
  const drafts = planSessionRecovery([
    event(HarnessEventType.RUN_STARTED, {}, 1),
    event(
      HarnessEventType.INPUT_REQUESTED,
      { inputId: "input-finished", questions: [], timeoutMs: 10_000 },
      2,
    ),
    event(HarnessEventType.INPUT_RESOLVED, { answers: [], inputId: "input-finished" }, 3),
    event(
      HarnessEventType.INPUT_REQUESTED,
      { executionId: "exec-1", inputId: "input-pending", questions: [], timeoutMs: 10_000 },
      4,
    ),
    event(HarnessEventType.RUN_COMPLETED, {}, 5),
  ]);

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.type, HarnessEventType.INPUT_EXPIRED);
  assert.deepEqual(drafts[0]?.data, {
    executionId: "exec-1",
    inputId: "input-pending",
    reason: "aborted",
  });
});
