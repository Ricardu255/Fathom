import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { createSessionHistoryTool } from "../src/pi/session-history-tool";
import { formatSessionHistoryHits, searchSessionHistory } from "../src/services/session-history";

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

function message(role: "assistant" | "user", text: string) {
  return {
    message: { content: [{ text, type: "text" }], role, timestamp: 2_000 + text.length },
  };
}

const events: HarnessEvent[] = [
  event(HarnessEventType.MESSAGE_COMPLETED, message("user", "帮我修复登录 bug"), 1),
  event(HarnessEventType.MESSAGE_COMPLETED, message("assistant", "登录逻辑在 src/auth.ts"), 2),
  event(
    HarnessEventType.TOOL_COMPLETED,
    {
      result: "src/auth.ts:42: error TS2322 登录类型错误",
      toolCallId: "t1",
      toolName: "search_text",
    },
    3,
  ),
  event(
    HarnessEventType.MESSAGE_COMPLETED,
    {
      hidden: true,
      message: { content: [{ text: "登录隐藏上下文", type: "text" }], role: "user", timestamp: 1 },
    },
    4,
  ),
  event(
    HarnessEventType.MESSAGE_COMPLETED,
    {
      message: {
        content: [{ content: "登录工具结果", toolUseId: "t0", type: "tool_result" }],
        role: "user",
        timestamp: 5,
      },
    },
    5,
  ),
  event(HarnessEventType.MESSAGE_COMPLETED, message("user", "继续修复注册"), 6),
];

test("按关键词检索可见消息与工具输出，返回消息序号与 seq", () => {
  const hits = searchSessionHistory(events, "登录", 10);
  assert.equal(hits.length, 3);
  assert.equal(hits[0]?.kind, "tool");
  assert.equal(hits[0]?.messageIndex, 2);
  assert.equal(hits[0]?.seq, 3);
  assert.match(hits[0]?.snippet ?? "", /登录类型错误/u);
  assert.equal(hits[1]?.kind, "assistant");
  assert.equal(hits[1]?.messageIndex, 2);
  assert.equal(hits[2]?.kind, "user");
  assert.equal(hits[2]?.messageIndex, 1);
  // hidden 和 tool-result-only 消息不占可见消息序号。
  assert.equal(searchSessionHistory(events, "注册", 10)[0]?.messageIndex, 3);
});

test("多关键词必须同时命中，limit 有界，片段有上限", () => {
  assert.equal(searchSessionHistory(events, "登录 接口", 10).length, 0);
  assert.equal(searchSessionHistory(events, "登录", 1).length, 1);

  const long = `${"a".repeat(1_000)}目标关键词${"b".repeat(1_000)}`;
  const longEvents = [event(HarnessEventType.MESSAGE_COMPLETED, message("assistant", long), 1)];
  const [hit] = searchSessionHistory(longEvents, "目标关键词", 5);
  assert.ok(hit !== undefined);
  assert.ok(hit.snippet.length <= 402, `片段过长: ${hit.snippet.length}`);
  assert.match(hit.snippet, /^…?a+目标关键词b+…?$/u);
});

test("格式化结果包含序号与时间；无命中时返回明确提示", () => {
  const hits = searchSessionHistory(events, "登录", 3);
  const formatted = formatSessionHistoryHits(hits);
  assert.match(formatted, /找到 3 条历史记录/u);
  assert.match(formatted, /消息 2 \/ seq 3/u);
  assert.equal(formatSessionHistoryHits([]), "没有找到匹配的历史记录。");
});

test("search_history 工具只读、格式化结果并拒绝空查询", async () => {
  const tool = createSessionHistoryTool(async () => events);
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.name, "search_history");
  const result = await tool.execute(
    { query: "登录", limit: 2 },
    { signal: new AbortController().signal, workspaceRoot: process.cwd() },
  );
  assert.match(result.content, /找到 2 条历史记录/u);
  assert.throws(() => tool.parse({ query: "" }));
  assert.match(tool.summarize({ query: "登录" }), /检索会话历史/u);
});
