import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkflowScheduler } from "../src/services/workflow-scheduler";
import type { WorkflowService } from "../src/services/workflow-service";

test("tick 只启动到期工作流并累计失败日志", async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const service = {
    async runScheduled(id: string) {
      calls.push(id);
      if (id === "bad") throw new Error("boom");
      return { runId: "run-1" };
    },
    listDue: () => [{ id: "good" }, { id: "bad" }],
  } as unknown as WorkflowService;
  const scheduler = new WorkflowScheduler({
    logger: {
      error: (details) => errors.push(details),
      warn: () => undefined,
    },
    service,
  });

  assert.equal(await scheduler.tick(1_000), 1);
  assert.deepEqual(calls, ["good", "bad"]);
  assert.equal(errors.length, 1);
});
