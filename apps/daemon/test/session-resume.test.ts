import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { buildResumePrompt } from "../src/services/session-resume";

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

test("续跑提示保留目标、上次输出和成功的工具，不重放副作用", () => {
  const prompt = buildResumePrompt([
    event(HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, 1),
    event(
      HarnessEventType.MESSAGE_COMPLETED,
      {
        message: { content: [{ text: "实现登录功能", type: "text" }], role: "user" },
      },
      2,
    ),
    event(
      HarnessEventType.TOOL_COMPLETED,
      {
        result: "写入 mock-demo.txt",
        toolCallId: "tool-1",
        toolName: "write_file",
      },
      3,
    ),
    event(
      HarnessEventType.MESSAGE_COMPLETED,
      {
        message: { content: [{ text: "下一步补测试", type: "text" }], role: "assistant" },
      },
      4,
    ),
    event(HarnessEventType.RUN_ABORTED, { code: "DAEMON_RESTART" }, 5),
  ]);
  assert.match(prompt, /不要重复已经成功的写操作/u);
  assert.match(prompt, /实现登录功能/u);
  assert.match(prompt, /下一步补测试/u);
  assert.match(prompt, /write_file/u);
});
