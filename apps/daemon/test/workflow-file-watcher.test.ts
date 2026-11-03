import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WorkflowFileWatcher } from "../src/services/workflow-file-watcher";
import type { WorkflowService } from "../src/services/workflow-service";

let root = "";
let calls = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-workflow-watch-"));
  await writeFile(join(root, "watched.txt"), "initial\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("文件变更会去抖后触发工作流", { timeout: 10_000 }, async () => {
  const service = {
    listFileWatchWorkflows: () => [
      {
        fileWatchPaths: ["watched.txt"],
        id: "workflow-1",
        triggerCondition: { type: "always" },
      },
    ],
    runTriggered: async () => {
      calls += 1;
      return { session: { id: "session-1" } };
    },
  } as unknown as WorkflowService;
  const watcher = new WorkflowFileWatcher({
    debounceMs: 100,
    logger: {
      error: () => undefined,
      warn: () => undefined,
    },
    service,
    workspaceRoot: root,
  });

  try {
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(join(root, "watched.txt"), "changed\n");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.ok(calls >= 1, `期望至少触发一次，实际 ${calls}`);
  } finally {
    watcher.stop();
  }
});
