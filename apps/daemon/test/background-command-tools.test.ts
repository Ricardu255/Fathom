import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BackgroundCommandService } from "../src/services/background-command-service";
import { createBackgroundCommandTools } from "../src/services/background-command-tools";

let root = "";
let service: BackgroundCommandService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-background-tools-"));
  service = new BackgroundCommandService();
});

after(async () => {
  service.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
});

test("后台命令工具暴露正确审批标记并读写输出", { timeout: 15_000 }, async () => {
  const tools = createBackgroundCommandTools(service, "session-tools", root);
  const start = tools.find((tool) => tool.name === "start_background_command");
  const list = tools.find((tool) => tool.name === "list_background_commands");
  const read = tools.find((tool) => tool.name === "read_background_command");
  const wait = tools.find((tool) => tool.name === "wait_background_command");
  const stop = tools.find((tool) => tool.name === "stop_background_command");
  assert.ok(
    start !== undefined &&
      list !== undefined &&
      read !== undefined &&
      wait !== undefined &&
      stop !== undefined,
  );
  assert.equal(start.requiresApproval, true);
  assert.equal(list.requiresApproval, false);
  assert.equal(read.requiresApproval, false);
  assert.equal(wait.requiresApproval, false);
  assert.equal(stop.requiresApproval, false);

  const context = { signal: new AbortController().signal, workspaceRoot: root };
  const started = await start.execute(
    { command: "node -e \"console.log('tool-bg')\"", name: "tool" },
    context,
  );
  const id = started.content.match(/([0-9a-f-]{36})/u)?.[1];
  assert.ok(id !== undefined);

  let output = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await read.execute({ id }, context);
    output = result.content;
    if (output.includes("tool-bg")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /tool-bg/u);
  const listed = await list.execute({}, context);
  assert.match(listed.content, /tool-bg/u);

  const waited = await wait.execute({ id, timeoutSeconds: 10 }, context);
  assert.match(waited.content, /已结束|exit/u);
  assert.match(waited.content, /tool-bg/u);
});
