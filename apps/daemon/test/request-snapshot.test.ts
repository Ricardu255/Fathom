import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestSnapshot } from "../src/services/request-snapshot";

test("请求快照保留 system prompt、工具与消息，并估算 token", () => {
  const snapshot = buildRequestSnapshot({
    messages: [
      { content: [{ text: "你好", type: "text" }], role: "user" },
      { content: [{ text: "你好！", type: "text" }], role: "assistant" },
    ],
    model: "test-model",
    requestIndex: 2,
    runId: "run-1",
    systemPrompt: "You are a test agent.",
    tools: [
      {
        description: "读取文件",
        inputSchema: { properties: {}, type: "object" },
        name: "read_file",
      },
    ],
  });
  assert.equal(snapshot.requestIndex, 2);
  assert.equal(snapshot.runId, "run-1");
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.tools[0]?.name, "read_file");
  assert.match(snapshot.systemPrompt, /test agent/u);
  assert.ok(snapshot.estimatedInputTokens > 0);
});

test("请求快照会省略图片 base64、截断超长文本并丢弃最旧消息", () => {
  const messages: Array<{ content: Array<Record<string, unknown>>; role: string }> = Array.from(
    { length: 260 },
    (_, index) => ({
      content: [{ text: `消息 ${index}`, type: "text" }],
      role: "user",
    }),
  );
  messages.push({
    content: [
      {
        data: "a".repeat(200_000),
        mimeType: "image/png",
        type: "image",
      },
      { text: "长文本".repeat(10_000), type: "text" },
    ],
    role: "user",
  });

  const snapshot = buildRequestSnapshot({
    messages,
    model: "test-model",
    requestIndex: 1,
    runId: null,
    systemPrompt: "system",
    tools: [{ description: "d".repeat(5_000), inputSchema: {}, name: "tool" }],
  });

  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.messages.length <= 200);
  assert.ok(snapshot.messages.length >= 1);
  const serialized = JSON.stringify(snapshot.messages);
  assert.doesNotMatch(serialized, /a{1000}/u);
  assert.match(serialized, /base64 omitted/u);
  assert.match(serialized, /truncated/u);
  assert.ok((snapshot.tools[0]?.description.length ?? 0) <= 2_100);
});
