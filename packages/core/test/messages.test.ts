import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "../src/messages";
import { sanitizeToolPairing } from "../src/messages";

function assistantWithToolCall(id: string): AgentMessage {
  return {
    content: [{ id, input: {}, name: "read_file", type: "tool_use" }],
    role: "assistant",
    timestamp: 1,
  };
}

test("sanitizeToolPairing 不拆分工具调用组，并补齐缺失的 tool_result", () => {
  const messages = sanitizeToolPairing([
    { content: [{ text: "读取文件", type: "text" }], role: "user", timestamp: 1 },
    assistantWithToolCall("call-1"),
    { content: [{ text: "然后继续", type: "text" }], role: "user", timestamp: 2 },
  ]);

  assert.equal(messages.length, 3);
  const assistant = messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.content[0]?.type, "tool_use");
  const resultMessage = messages[2];
  assert.equal(resultMessage?.role, "user");
  assert.ok(
    resultMessage?.content.some(
      (block) => block.type === "tool_result" && block.toolUseId === "call-1",
    ),
    "tool_use 后必须紧跟对应 tool_result",
  );
});

test("sanitizeToolPairing 移除孤立 tool_result，并合并相邻同角色消息", () => {
  const messages = sanitizeToolPairing([
    {
      content: [{ content: "孤儿结果", toolUseId: "missing", type: "tool_result" }],
      role: "user",
      timestamp: 1,
    },
    { content: [{ text: "问题", type: "text" }], role: "user", timestamp: 2 },
    { content: [{ text: "回答", type: "text" }], role: "assistant", timestamp: 3 },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.deepEqual(messages[0]?.content, [{ text: "问题", type: "text" }]);
  assert.equal(messages[1]?.role, "assistant");
});
