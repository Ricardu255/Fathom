import assert from "node:assert/strict";
import { test } from "node:test";
import {
  distanceFromBottom,
  FOLLOW_THRESHOLD_PX,
  isNearBottom,
} from "../src/features/chat/follow-bottom";

test("底部还剩的距离按滚动位置计算，不会出现负数", () => {
  assert.equal(distanceFromBottom({ clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 }), 0);
  assert.equal(distanceFromBottom({ clientHeight: 600, scrollHeight: 2000, scrollTop: 1000 }), 400);
});

test("在阈值内视为跟随，超过阈值停止跟随", () => {
  const base = { clientHeight: 600, scrollHeight: 2000 };
  assert.equal(isNearBottom({ ...base, scrollTop: 1400 }), true);
  assert.equal(isNearBottom({ ...base, scrollTop: 1400 - FOLLOW_THRESHOLD_PX }), true);
  assert.equal(isNearBottom({ ...base, scrollTop: 1400 - FOLLOW_THRESHOLD_PX - 1 }), false);
});

test("内容比视口还短时始终视为在底部", () => {
  assert.equal(isNearBottom({ clientHeight: 800, scrollHeight: 300, scrollTop: 0 }), true);
});
