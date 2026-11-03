import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentMessage,
  type HarnessEvent,
  HarnessEventType,
  type MessageCompletedData,
} from "@harness/core";
import { PiEventBridge } from "../src/pi/event-bridge";
import { projectEvents } from "../src/services/session-projections";

test("memory 前缀只进入模型上下文，不进入用户可见消息", async () => {
  const drafts: { data: unknown; type: string }[] = [];
  const bridge = new PiEventBridge(
    async (draft) => {
      drafts.push({ data: draft.data, type: draft.type });
      return {
        data: draft.data,
        id: "event-1",
        runId: draft.runId,
        seq: 1,
        sessionId: "session-1",
        timestamp: 1,
        type: draft.type,
      } satisfies HarnessEvent;
    },
    {
      consumeQueuedText: () => undefined,
      onQueueUpdate: () => undefined,
    },
    () => "mock",
    () => [],
  );
  const prefix = "相关长期记忆：\n1. [偏好] 使用 pnpm";
  bridge.setRun("run-1");
  bridge.setPromptPrefix(prefix);

  await bridge.handle({
    message: {
      content: [{ text: `${prefix}\n\n请实现登录`, type: "text" }],
      role: "user",
      timestamp: 10,
    },
    type: "message_end",
  } as AgentSessionEvent);

  const messageEvent = drafts.find((draft) => draft.type === HarnessEventType.MESSAGE_COMPLETED);
  assert.ok(messageEvent !== undefined);
  const message = (messageEvent.data as MessageCompletedData).message as AgentMessage;
  assert.deepEqual(message.content, [{ text: "请实现登录", type: "text" }]);
});

test("projectEvents 保留计划并在新 Run 开始时清空", () => {
  const plan = {
    data: { planId: "plan-1", text: "1. 读取文件\n2. 修改实现" },
    id: "event-plan",
    runId: "run-1",
    seq: 1,
    sessionId: "session-1",
    timestamp: 1,
    type: HarnessEventType.PLAN_CREATED,
  } as const;
  assert.equal(projectEvents([plan]).plan?.planId, "plan-1");
  assert.equal(
    projectEvents([
      plan,
      {
        data: { model: "mock", tools: [] },
        id: "event-run",
        runId: "run-2",
        seq: 2,
        sessionId: "session-1",
        timestamp: 2,
        type: HarnessEventType.RUN_STARTED,
      },
    ]).plan,
    null,
  );
});

test("projectEvents 保留最近一次记忆召回元数据", () => {
  const projections = projectEvents([
    {
      data: { memoryIds: ["m1", "m2"], titles: ["偏好", "约束"] },
      id: "event-1",
      runId: "run-1",
      seq: 1,
      sessionId: "session-1",
      timestamp: 1,
      type: HarnessEventType.MEMORY_RECALLED,
    },
  ]);
  assert.deepEqual(projections.memoryRecall, {
    memoryIds: ["m1", "m2"],
    titles: ["偏好", "约束"],
  });
});
