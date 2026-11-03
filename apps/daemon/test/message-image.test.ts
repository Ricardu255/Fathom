import assert from "node:assert/strict";
import { test } from "node:test";
import { toOurMessage } from "../src/pi/event-bridge";

test("用户图片消息保留为 image block，而不是 [图片消息] 文本", () => {
  const message = toOurMessage({
    content: [
      { text: "看看这张图", type: "text" },
      { data: "aGVsbG8=", mimeType: "image/png", type: "image" },
    ],
    role: "user",
    timestamp: 1_000,
  } as Parameters<typeof toOurMessage>[0]);

  assert.ok(message !== null);
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [
    { text: "看看这张图", type: "text" },
    { data: "aGVsbG8=", mimeType: "image/png", type: "image" },
  ]);
});
