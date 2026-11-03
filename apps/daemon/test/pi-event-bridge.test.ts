import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { PiEventBridge } from "../src/pi/event-bridge";

test("压缩与重试事件携带真实 token、消息数与重试策略字段", async () => {
  const emitted: HarnessEvent[] = [];
  const bridge = new PiEventBridge(
    async (draft) => {
      const event: HarnessEvent = {
        ...draft,
        id: `event-${emitted.length + 1}`,
        seq: emitted.length + 1,
        sessionId: "session-1",
        timestamp: 1,
      } as HarnessEvent;
      emitted.push(event);
      return event;
    },
    {
      compactionStats: () => ({ replacedMessages: 3, retainedFrom: 42 }),
      consumeQueuedText: () => undefined,
      contextUsage: () => ({ limit: 200_000, tokens: 1_234 }),
      onQueueUpdate: () => undefined,
    },
    () => "test-model",
    () => [],
  );
  bridge.setRun("run-1");

  await bridge.handle({
    reason: "threshold",
    type: "compaction_start",
  } as unknown as AgentSessionEvent);
  assert.deepEqual(emitted.at(-1)?.data, { estimatedTokens: 1_234, limit: 200_000 });

  await bridge.handle({
    aborted: false,
    reason: "threshold",
    result: {
      estimatedTokensAfter: 200,
      firstKeptEntryId: "entry-1",
      summary: "摘要",
      tokensBefore: 1_000,
      usage: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5 },
    },
    type: "compaction_end",
    willRetry: false,
  } as unknown as AgentSessionEvent);

  const compacted = emitted.find((event) => event.type === HarnessEventType.CONTEXT_COMPACTED);
  assert.deepEqual(compacted?.data, {
    afterTokens: 200,
    beforeTokens: 1_000,
    replacedMessages: 3,
    retainedFrom: 42,
    summary: "摘要",
  });
  const usage = emitted.find((event) => event.type === HarnessEventType.USAGE);
  assert.deepEqual(usage?.data, { inputTokens: 10, model: "test-model", outputTokens: 5 });

  await bridge.handle({
    attempt: 2,
    delayMs: 4_000,
    errorMessage: "rate limited",
    maxAttempts: 5,
    type: "auto_retry_start",
  } as unknown as AgentSessionEvent);
  assert.deepEqual(emitted.at(-1)?.data, {
    attempt: 2,
    code: "AUTO_RETRY",
    delayMs: 4_000,
    maxAttempts: 5,
    message: "rate limited",
  });

  await bridge.handle({
    attempt: 1,
    delayMs: 2_000,
    errorMessage: "summary failed",
    maxAttempts: 3,
    type: "summarization_retry_scheduled",
  } as unknown as AgentSessionEvent);
  assert.deepEqual(emitted.at(-1)?.data, {
    attempt: 1,
    code: "COMPACTION_RETRY",
    delayMs: 2_000,
    maxAttempts: 3,
    message: "summary failed",
  });
});
