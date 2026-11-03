import assert from "node:assert/strict";
import { test } from "node:test";
import { describeApproval } from "../src/pi/tools";

test("Shell 审批描述命令、风险与影响", () => {
  const safe = describeApproval("run_command", { command: "git status" });
  assert.equal(safe.risk, "normal");
  assert.equal(safe.target, "git status");
  assert.match(safe.consequence ?? "", /命令/u);

  const risky = describeApproval("run_command", { command: "rm -rf build" });
  assert.equal(risky.risk, "high");
  assert.equal(risky.target, "rm -rf build");
});

test("文件与记忆审批显示目标", () => {
  assert.equal(describeApproval("write_file", { path: "src/a.ts" }).target, "src/a.ts");
  assert.equal(describeApproval("write_file", { path: "src/a.ts" }).risk, "normal");
  assert.equal(describeApproval("forget_memory", {}).target, "删除记忆");
});
