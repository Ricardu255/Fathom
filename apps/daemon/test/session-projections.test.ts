import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { projectEvents } from "../src/services/session-projections";

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

test("新 Run 开始时清空上一 Run 的 Plan 与 Todos", () => {
  const projections = projectEvents([
    event(
      HarnessEventType.TODOS_UPDATED,
      {
        todos: [{ content: "旧任务", id: "todo-1", status: "completed" }],
      },
      1,
    ),
    event(HarnessEventType.PLAN_CREATED, { planId: "plan-1", text: "旧计划" }, 2),
    event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 3),
  ]);

  assert.deepEqual(projections.todos, []);
  assert.equal(projections.plan, null);
});

test("工具事件投影为可恢复的工具卡，并在新 Run 时清空", () => {
  const longResult = "x".repeat(16_500);
  const projections = projectEvents([
    event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 1),
    event(
      HarnessEventType.TOOL_STARTED,
      { input: { path: "a.txt" }, toolCallId: "tool-1", toolName: "read_file" },
      2,
    ),
    event(
      HarnessEventType.TOOL_COMPLETED,
      { result: longResult, toolCallId: "tool-1", toolName: "read_file" },
      3,
    ),
    event(
      HarnessEventType.TOOL_STARTED,
      { input: { command: "false" }, toolCallId: "tool-2", toolName: "run_command" },
      4,
    ),
    event(
      HarnessEventType.TOOL_FAILED,
      { error: "boom", toolCallId: "tool-2", toolName: "run_command" },
      5,
    ),
  ]);
  assert.deepEqual(projections.tools, [
    {
      id: "tool-1",
      input: { path: "a.txt" },
      name: "read_file",
      result: longResult.slice(0, 16_000),
      resultTruncated: true,
      status: "completed",
    },
    {
      id: "tool-2",
      input: { command: "false" },
      name: "run_command",
      error: "boom",
      status: "failed",
    },
  ]);

  const nextRun = projectEvents([
    event(
      HarnessEventType.TOOL_STARTED,
      { input: {}, toolCallId: "tool-1", toolName: "read_file" },
      1,
    ),
    event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 2),
  ]);
  assert.deepEqual(nextRun.tools, []);
});

test("未决提问进入快照，解决或过期后移除", () => {
  const pending = {
    inputId: "input-1",
    questions: [
      {
        allowCustomInput: true,
        body: "",
        id: "q1",
        multiSelect: false,
        options: [],
        title: "问题",
      },
    ],
    timeoutMs: 10_000,
  };
  const withPending = projectEvents([event(HarnessEventType.INPUT_REQUESTED, pending, 1)]);
  assert.deepEqual(withPending.userInputs, [pending]);

  const afterResolved = projectEvents([
    event(HarnessEventType.INPUT_REQUESTED, pending, 1),
    event(HarnessEventType.INPUT_RESOLVED, { answers: [], inputId: "input-1" }, 2),
  ]);
  assert.deepEqual(afterResolved.userInputs, []);

  const afterExpired = projectEvents([
    event(HarnessEventType.INPUT_REQUESTED, pending, 1),
    event(HarnessEventType.INPUT_EXPIRED, { inputId: "input-1", reason: "timeout" }, 2),
  ]);
  assert.deepEqual(afterExpired.userInputs, []);
});
