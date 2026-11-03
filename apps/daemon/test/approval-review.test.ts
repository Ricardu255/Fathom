import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApprovalReviewPrompt, parseApprovalReview } from "../src/pi/approval-review";

test("approval review 只接受明确的 allow", () => {
  assert.equal(parseApprovalReview('{"decision":"allow"}'), "allow");
  assert.equal(parseApprovalReview('```json\n{"decision":"ALLOW"}\n```'), "allow");
  assert.equal(parseApprovalReview('{"decision":"deny"}'), "ask");
  assert.equal(parseApprovalReview('{"decision":"ask"}'), "ask");
  assert.equal(parseApprovalReview("not json"), "ask");
  assert.equal(parseApprovalReview('{"decision":"allow"'), "ask");
});

test("approval review prompt 包含工具与有界参数", () => {
  const prompt = buildApprovalReviewPrompt({
    input: { command: "git status" },
    summary: "git status",
    toolCallId: "call-1",
    toolName: "run_command",
  });
  assert.match(prompt, /run_command/u);
  assert.match(prompt, /git status/u);
  assert.match(prompt, /只返回 JSON/u);
});
