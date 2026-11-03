import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEventCursor } from "../src/services/event-cursor";

test("没有游标时从头开始", () => {
  assert.equal(resolveEventCursor({}), 0);
  assert.equal(resolveEventCursor({ afterSeq: "" }), 0);
});

test("查询参数优先于 Last-Event-ID", () => {
  assert.equal(resolveEventCursor({ afterSeq: "12", lastEventId: "7" }), 12);
});

test("没有查询参数时使用浏览器重连带来的 Last-Event-ID", () => {
  assert.equal(resolveEventCursor({ lastEventId: "42" }), 42);
});

test("非法游标返回 -1，而不是静默当成 0", () => {
  for (const bad of ["-1", "1.5", "abc", "1e3", " 3", "0x10"]) {
    assert.equal(resolveEventCursor({ afterSeq: bad }), -1, `${bad} 应被视为非法`);
  }
  assert.equal(resolveEventCursor({ lastEventId: "oops" }), -1);
});
