import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_FOLLOW_UP_MARKER,
  AUTO_FOLLOW_UP_SYSTEM_INSTRUCTION,
  createAutoFollowUpExtension,
  requestsAutoFollowUp,
  stripAutoFollowUpMarker,
  stripMarkerFromMessage,
} from "../src/pi/auto-follow-up";

function assistant(text: string) {
  return { content: [{ text, type: "text" as const }], role: "assistant" as const, timestamp: 1 };
}

test("只有末尾独立的续轮标记才会触发下一轮", () => {
  assert.equal(requestsAutoFollowUp(assistant(`第一步完成。\n${AUTO_FOLLOW_UP_MARKER}`)), true);
  assert.equal(requestsAutoFollowUp(assistant(AUTO_FOLLOW_UP_MARKER)), true);
  assert.equal(requestsAutoFollowUp(assistant("普通回答")), false);
  assert.equal(requestsAutoFollowUp(assistant(`${AUTO_FOLLOW_UP_MARKER}\n后面还有文字`)), false);
  assert.equal(requestsAutoFollowUp({ content: [], role: "assistant" }), false);
});

test("展示前会移除续轮标记，且系统提示包含标记协议", () => {
  assert.equal(stripAutoFollowUpMarker(`第一步完成。\n${AUTO_FOLLOW_UP_MARKER}`), "第一步完成。");
  assert.equal(stripAutoFollowUpMarker(AUTO_FOLLOW_UP_MARKER), "");
  const stripped = stripMarkerFromMessage(assistant(`结果\n${AUTO_FOLLOW_UP_MARKER}`));
  assert.deepEqual(stripped.content, [{ text: "结果", type: "text" }]);
  assert.match(AUTO_FOLLOW_UP_SYSTEM_INSTRUCTION, /FATHOM_CONTINUE/u);
});

test("agent_before_settle 只在 canContinue 且策略允许时请求续轮", () => {
  let allow = true;
  let handler: ((event: { context: { canContinue: boolean } }) => unknown) | undefined;
  const extension = createAutoFollowUpExtension(() => allow);
  if (typeof extension === "function") assert.fail("expected an inline extension object");
  const factory = extension.factory;
  factory({
    on: (name: string, callback: typeof handler) => {
      if (name === "agent_before_settle") handler = callback;
      return () => undefined;
    },
  } as unknown as Parameters<typeof factory>[0]);
  assert.notEqual(handler, undefined);
  const continued = handler?.({ context: { canContinue: true } }) as
    | { continue?: boolean; entries?: Array<{ type?: string }> }
    | undefined;
  assert.equal(continued?.continue, true);
  assert.equal(continued?.entries?.[0]?.type, "custom_message");
  allow = false;
  assert.equal(handler?.({ context: { canContinue: true } }), undefined);
});
