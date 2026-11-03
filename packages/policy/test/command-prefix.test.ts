import assert from "node:assert/strict";
import { test } from "node:test";
import { commandMatchesPrefix, suggestCommandPrefix, validateCommandPrefix } from "../src/index";

test("安全简单命令生成 token 前缀", () => {
  assert.equal(suggestCommandPrefix("git status --short"), "git status");
  assert.equal(suggestCommandPrefix("npm test"), "npm test");
  assert.equal(suggestCommandPrefix("ls -la"), "ls");
});

test("高风险或复杂命令不生成前缀", () => {
  assert.equal(suggestCommandPrefix("rm -rf build"), null);
  assert.equal(suggestCommandPrefix("git status && rm -rf build"), null);
  assert.equal(suggestCommandPrefix("echo $(whoami)"), null);
});

test("前缀按 token 匹配且拒绝高风险命令", () => {
  assert.equal(commandMatchesPrefix("git status --short", "git status"), true);
  assert.equal(commandMatchesPrefix("git status2", "git status"), false);
  assert.equal(commandMatchesPrefix("rm -rf build", "rm"), false);
  assert.equal(validateCommandPrefix("git status"), true);
  assert.equal(validateCommandPrefix("git status --short"), false);
});
