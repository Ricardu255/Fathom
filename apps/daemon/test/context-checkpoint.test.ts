import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import {
  buildContextCheckpoint,
  collectCheckpoints,
  compareCheckpoints,
  formatCheckpointForPrompt,
  latestUnconsumedRestore,
  parseCheckpointSections,
} from "../src/services/context-checkpoint";

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

test("从事件与摘要派生结构化检查点", () => {
  const summary = [
    "## 目标",
    "完成登录",
    "## 约束",
    "- 不新增依赖",
    "## 决策",
    "- 使用 JWT",
    "## 已完成",
    "- 建表",
    "## 待完成",
    "- 接口",
    "## 阻塞",
    "- 等待密钥",
    "## 下一步",
    "- 补测试",
  ].join("\n");
  const checkpoint = buildContextCheckpoint(
    [
      event(
        HarnessEventType.MESSAGE_COMPLETED,
        {
          message: {
            content: [{ text: "实现登录功能", type: "text" }],
            role: "user",
            timestamp: 1,
          },
        },
        1,
      ),
      event(
        HarnessEventType.TODOS_UPDATED,
        {
          todos: [
            { content: "建表", id: "todo-1", status: "completed" },
            { content: "写接口", id: "todo-2", status: "in_progress" },
            { content: "补文档", id: "todo-3", status: "pending" },
            { content: "等密钥", id: "todo-4", status: "blocked" },
          ],
        },
        2,
      ),
      event(
        HarnessEventType.APPROVAL_REQUESTED,
        {
          approvalId: "approval-1",
          input: {},
          summary: "写入 src/auth.ts",
          toolCallId: "tool-1",
          toolName: "write_file",
        },
        3,
      ),
      event(
        HarnessEventType.INPUT_REQUESTED,
        {
          inputId: "input-1",
          questions: [{ title: "选择数据库", options: [] }],
        },
        4,
      ),
      event(
        HarnessEventType.TOOL_FAILED,
        {
          error: "exit 1",
          toolCallId: "tool-2",
          toolName: "run_command",
        },
        5,
      ),
    ],
    summary,
  );

  assert.equal(checkpoint.goal, "实现登录功能");
  assert.deepEqual(checkpoint.constraints, ["不新增依赖"]);
  assert.deepEqual(checkpoint.decisions, ["使用 JWT"]);
  assert.deepEqual(checkpoint.completed, ["建表"]);
  assert.ok(checkpoint.pending.includes("写接口"));
  assert.ok(checkpoint.pending.includes("补文档"));
  assert.ok(checkpoint.blockers.includes("等密钥"));
  assert.ok(checkpoint.blockers.includes("等待审批：写入 src/auth.ts"));
  assert.ok(checkpoint.blockers.includes("等待用户回答：选择数据库"));
  assert.ok(checkpoint.blockers.includes("工具 run_command 失败：exit 1"));
  assert.ok(checkpoint.nextSteps.includes("写接口"));
  assert.ok(checkpoint.nextSteps.includes("补测试"));
});

test("解析中英文分节标题", () => {
  const sections = parseCheckpointSections(
    [
      "Goal: ship it",
      "Constraints",
      "- no new deps; keep API stable",
      "Decisions: use SQLite",
      "下一步：补测试",
      "Blockers",
      "- waiting for key",
      "Next steps",
      "1. write docs",
    ].join("\n"),
  );
  assert.deepEqual(sections.goal, ["ship it"]);
  assert.deepEqual(sections.constraints, ["no new deps", "keep API stable"]);
  assert.deepEqual(sections.decisions, ["use SQLite"]);
  assert.deepEqual(sections.nextSteps, ["补测试", "write docs"]);
  assert.deepEqual(sections.blockers, ["waiting for key"]);
});

test("收集检查点版本链并保留上一版本与覆盖范围", () => {
  const checkpoints = collectCheckpoints([
    event(
      HarnessEventType.CONTEXT_COMPACTED,
      {
        afterTokens: 10,
        beforeTokens: 100,
        checkpoint: {
          blockers: [],
          completed: [],
          constraints: [],
          decisions: [],
          goal: "一",
          nextSteps: [],
          pending: [],
        },
        checkpointId: "cp-1",
        coveredFromSeq: 1,
        coveredToSeq: 5,
        previousCheckpointId: null,
        replacedMessages: 2,
        summary: "第一版",
        trigger: "auto",
      },
      5,
    ),
    event(
      HarnessEventType.CONTEXT_COMPACTED,
      {
        afterTokens: 10,
        beforeTokens: 100,
        checkpoint: {
          blockers: [],
          completed: [],
          decisions: [],
          constraints: [],
          goal: "二",
          nextSteps: [],
          pending: [],
        },
        checkpointId: "cp-2",
        coveredFromSeq: 6,
        coveredToSeq: 9,
        previousCheckpointId: "cp-1",
        replacedMessages: 1,
        summary: "第二版",
        trigger: "manual",
      },
      9,
    ),
  ]);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[1]?.checkpointId, "cp-2");
  assert.equal(checkpoints[1]?.previousCheckpointId, "cp-1");
  assert.equal(checkpoints[1]?.coveredFromSeq, 6);
  assert.equal(checkpoints[1]?.trigger, "manual");
});

test("对比只返回变化的字段，恢复事件在下一次 Run 开始时失效", () => {
  const base = {
    blockers: ["等密钥"],
    completed: ["建表"],
    constraints: [],
    decisions: [],
    goal: "实现登录",
    nextSteps: ["写接口"],
    pending: ["写接口"],
  };
  const target = {
    ...base,
    completed: ["建表", "写接口"],
    constraints: ["不新增依赖"],
    goal: "实现登录与注册",
    pending: [],
  };
  const fields = compareCheckpoints(base, target);
  assert.deepEqual(fields.map((entry) => entry.field).sort(), [
    "completed",
    "constraints",
    "goal",
    "pending",
  ]);
  const goalDiff = fields.find((entry) => entry.field === "goal");
  assert.deepEqual(goalDiff?.added, ["实现登录与注册"]);
  const pendingDiff = fields.find((entry) => entry.field === "pending");
  assert.deepEqual(pendingDiff?.removed, ["写接口"]);

  const restored = {
    checkpoint: target,
    checkpointId: "cp-2",
  };
  const restoreEvent = event(HarnessEventType.CONTEXT_CHECKPOINT_RESTORED, restored, 10, null);
  assert.deepEqual(latestUnconsumedRestore([restoreEvent]), restored);
  assert.equal(
    latestUnconsumedRestore([
      restoreEvent,
      event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 11),
    ]),
    null,
  );

  const prompt = formatCheckpointForPrompt(target);
  assert.match(prompt, /【恢复的上下文检查点】/u);
  assert.match(prompt, /目标：实现登录与注册/u);
  assert.match(prompt, /约束：/u);
  assert.match(prompt, /- 不新增依赖/u);
});
