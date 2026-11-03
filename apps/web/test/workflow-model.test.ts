import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkflowNode,
  createWorkflowTemplate,
  validateWorkflow,
  type WorkflowNodeDraft,
} from "../src/features/workflow/workflow-model";

function node(overrides: Partial<WorkflowNodeDraft>): WorkflowNodeDraft {
  return { ...createWorkflowNode(1), ...overrides };
}

test("示例模板是合法 DAG", () => {
  assert.deepEqual(validateWorkflow(createWorkflowTemplate()), []);
});

test("校验空任务、重复 id、缺失依赖与自依赖", () => {
  const errors = validateWorkflow([
    node({ id: "a", task: "" }),
    node({ id: "a", dependsOn: ["missing", "a"], task: "执行" }),
  ]);
  assert.ok(errors.some((error) => error.includes("缺少任务描述")));
  assert.ok(errors.some((error) => error.includes("id 重复")));
  assert.ok(errors.some((error) => error.includes("依赖不存在")));
  assert.ok(errors.some((error) => error.includes("不能依赖自己")));
});

test("校验依赖环与节点上限", () => {
  const cyclic = validateWorkflow([
    node({ id: "a", dependsOn: ["b"], task: "A" }),
    node({ id: "b", dependsOn: ["a"], task: "B" }),
  ]);
  assert.ok(cyclic.includes("工作流依赖存在环"));

  const tooMany = Array.from({ length: 13 }, (_, index) => node({ id: `n${index}`, task: "任务" }));
  assert.ok(validateWorkflow(tooMany).some((error) => error.includes("最多 12")));
});
