import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeWork } from "../src/features/chat/work-summary";

const plan = { planId: "plan-1", text: "## 计划" };

test("没有计划也没有任务时不显示胶囊", () => {
  const summary = summarizeWork({ plan: null, todos: [] });
  assert.equal(summary.hasWork, false);
  assert.equal(summary.currentStep, null);
});

test("统计完成数，并优先把进行中的任务当作当前步骤", () => {
  const summary = summarizeWork({
    plan: null,
    todos: [
      { content: "读代码", id: "1", status: "completed" },
      { content: "写实现", id: "2", status: "in_progress" },
      { content: "补测试", id: "3", status: "pending" },
    ],
  });
  assert.equal(summary.todoCompleted, 1);
  assert.equal(summary.todoTotal, 3);
  assert.equal(summary.currentStep, "写实现");
  assert.equal(summary.hasWork, true);
});

test("没有进行中的任务时回退到阻塞项，再回退到待开始", () => {
  assert.equal(
    summarizeWork({
      plan: null,
      todos: [
        { content: "待开始", id: "1", status: "pending" },
        { content: "被阻塞", id: "2", status: "blocked" },
      ],
    }).currentStep,
    "被阻塞",
  );
  assert.equal(
    summarizeWork({
      plan: null,
      todos: [{ content: "待开始", id: "1", status: "pending" }],
    }).currentStep,
    "待开始",
  );
});

test("只有计划没有任务时仍然显示，且算作有工作", () => {
  const summary = summarizeWork({ plan, todos: [] });
  assert.equal(summary.planActive, true);
  assert.equal(summary.hasWork, true);
  assert.equal(summary.currentStep, null);
});

test("空白计划不算计划", () => {
  assert.equal(summarizeWork({ plan: { planId: "p", text: "   " }, todos: [] }).hasWork, false);
});
