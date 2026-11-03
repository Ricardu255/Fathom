import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDesktopToken } from "../src/services/desktop-token";

test("桌面令牌只接受完全一致的副本", () => {
  assert.equal(matchesDesktopToken("token-abc", "token-abc"), true);
  assert.equal(matchesDesktopToken("token-abc", "token-abd"), false);
});

test("长度不同的令牌不会让比较抛错", () => {
  assert.equal(matchesDesktopToken("abc", "abcd"), false);
  assert.equal(matchesDesktopToken("x".repeat(1_000), "abc"), false);
});

test("缺少任何一侧都视为不匹配", () => {
  assert.equal(matchesDesktopToken(undefined, "token-abc"), false);
  assert.equal(matchesDesktopToken("token-abc", undefined), false);
  assert.equal(matchesDesktopToken("", "token-abc"), false);
  assert.equal(matchesDesktopToken("token-abc", ""), false);
});
