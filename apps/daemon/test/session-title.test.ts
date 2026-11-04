import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistantText,
  buildTitlePrompt,
  fallbackSessionTitle,
  sanitizeGeneratedTitle,
} from "../src/services/session-title";

test("回退标题把首条输入压成一行并截到 40 字", () => {
  assert.equal(fallbackSessionTitle("  帮我   重构\n这个模块  "), "帮我 重构 这个模块");
  assert.equal(fallbackSessionTitle("字".repeat(60)).length, 40);
});

test("模型标题会剥掉引号、前缀和结尾标点", () => {
  assert.equal(sanitizeGeneratedTitle("「重构提交流程」"), "重构提交流程");
  assert.equal(sanitizeGeneratedTitle("标题：重构提交流程。"), "重构提交流程");
  assert.equal(sanitizeGeneratedTitle("title: Refactor the flow"), "Refactor the flow");
  assert.equal(sanitizeGeneratedTitle('"Refactor"'), "Refactor");
});

test("模型标题取第一行有内容的文本，超长截断", () => {
  assert.equal(sanitizeGeneratedTitle("\n\n  重构提交流程 \n其他解释"), "重构提交流程");
  assert.equal(sanitizeGeneratedTitle("字".repeat(60))?.length, 40);
});

test("清洗后为空视为没有生成成功", () => {
  assert.equal(sanitizeGeneratedTitle(""), null);
  assert.equal(sanitizeGeneratedTitle("   \n\n "), null);
  assert.equal(sanitizeGeneratedTitle('""'), null);
});

test("标题提示词带上原文，并截断超长输入", () => {
  const prompt = buildTitlePrompt("x".repeat(5_000));
  assert.match(prompt, /^为下面这段对话起一个标题/u);
  assert.ok(prompt.length < 2_200);
});

test("助手消息只取文本，出错时返回空串", () => {
  assert.equal(
    assistantText({
      content: [
        { text: "重构", type: "text" },
        { text: "提交流程", type: "text" },
        { type: "toolCall" },
      ],
    }),
    "重构提交流程",
  );
  assert.equal(assistantText({ content: [], errorMessage: "boom" }), "");
});
