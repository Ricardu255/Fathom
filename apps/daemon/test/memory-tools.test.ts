import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryService } from "../src/memory/memory-service";
import { createMemoryTools } from "../src/memory/memory-tools";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let memory: MemoryService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-memory-tools-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
  memory = new MemoryService({ database });
});

after(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("memory 工具暴露 save/search/forget 并标记写操作审批", async () => {
  const tools = createMemoryTools(memory);
  const save = tools.find((tool) => tool.name === "save_memory");
  const search = tools.find((tool) => tool.name === "search_memory");
  const forget = tools.find((tool) => tool.name === "forget_memory");
  assert.ok(save !== undefined);
  assert.ok(search !== undefined);
  assert.ok(forget !== undefined);
  assert.equal(save.requiresApproval, true);
  assert.equal(search.requiresApproval, false);
  assert.equal(forget.requiresApproval, true);

  const context = {
    signal: new AbortController().signal,
    workspaceRoot: root,
  };
  const saved = await save.execute(
    { content: "工具测试记忆：使用 Vitest 风格命名。", title: "工具测试" },
    context,
  );
  assert.match(saved.content, /已保存记忆/u);
  const found = await search.execute({ query: "Vitest" }, context);
  assert.match(found.content, /工具测试/u);
  const id = found.content.match(/id: ([0-9a-f-]+)/u)?.[1];
  assert.ok(id !== undefined);
  const forgotten = await forget.execute({ id }, context);
  assert.match(forgotten.content, /已删除记忆/u);
});
