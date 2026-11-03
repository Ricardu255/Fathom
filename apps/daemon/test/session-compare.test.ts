import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { buildMergeSummary, compareSessionEvents } from "../src/services/session-compare";

function messageEvent(
  role: "assistant" | "user",
  text: string,
  timestamp: number,
  seq: number,
): HarnessEvent {
  return {
    data: { message: { content: [{ text, type: "text" }], role, timestamp } },
    id: `event-${seq}`,
    runId: "run-1",
    seq,
    sessionId: "session-1",
    timestamp,
    type: HarnessEventType.MESSAGE_COMPLETED,
  };
}

test("compareSessionEvents 找出共同前缀与各自分叉内容", () => {
  const base = [
    messageEvent("user", "共同问题", 1, 1),
    messageEvent("assistant", "共同回答", 2, 2),
    messageEvent("assistant", "父分支新增", 3, 3),
  ];
  const target = [
    messageEvent("user", "共同问题", 1, 1),
    messageEvent("assistant", "共同回答", 2, 2),
    messageEvent("user", "子分支问题", 4, 3),
  ];
  const diff = compareSessionEvents(base, target);
  assert.equal(diff.commonPrefix, 2);
  assert.deepEqual(
    diff.base.messages.map((message) => message.content[0]),
    [{ text: "父分支新增", type: "text" }],
  );
  assert.deepEqual(
    diff.target.messages.map((message) => message.content[0]),
    [{ text: "子分支问题", type: "text" }],
  );
});

test("buildMergeSummary 包含最后结果与文件路径", () => {
  const summary = buildMergeSummary("来源分支", [
    messageEvent("assistant", "来源结论", 1, 1),
    {
      data: { after: "a", before: "", diff: "diff", path: "src/a.ts" },
      id: "event-file",
      runId: "run-1",
      seq: 2,
      sessionId: "session-1",
      timestamp: 2,
      type: HarnessEventType.FILE_CHANGED,
    },
  ]);
  assert.match(summary, /来源分支：来源分支/u);
  assert.match(summary, /来源结论/u);
  assert.match(summary, /src\/a\.ts/u);
});
