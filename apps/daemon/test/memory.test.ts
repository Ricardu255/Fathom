import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MemoryService, MemoryServiceError } from "../src/memory/memory-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let memory: MemoryService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-memory-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
  memory = new MemoryService({ database });
  await memory.initialize();
});

after(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("memory CRUD、kind 隔离与去重更新", async () => {
  const created = await memory.create({
    content: "用户偏好使用 pnpm 和 TypeScript strict 模式。",
    title: "工程偏好",
  });
  assert.equal(created.title, "工程偏好");
  assert.equal(memory.list().length, 1);

  database.indexKnowledgeDocument(
    { id: "literature:demo", kind: "literature", sourceId: "demo", title: "论文" },
    [
      {
        content: "这篇论文讨论了 pnpm workspace 的组织方式。",
        id: "literature:demo:0",
        ordinal: 0,
        pageEnd: 3,
        pageStart: 3,
        section: "Methods",
      },
    ],
  );

  const memoryHits = await memory.search("pnpm");
  assert.equal(memoryHits.length, 1);
  assert.equal(memoryHits[0]?.kind, "memory");
  assert.equal(memoryHits[0]?.pageStart, 0);

  const allHits = database.searchKnowledge("pnpm", 10);
  assert.equal(allHits.length, 2);
  assert.equal(database.searchKnowledge("pnpm", 10, ["literature"]).length, 1);

  const updated = await memory.update(created.id, { content: "用户现在偏好 npm。" });
  assert.equal(updated.content, "用户现在偏好 npm。");
  assert.equal(
    (await memory.search("pnpm")).some((hit) => hit.content.includes("pnpm")),
    false,
  );
  assert.equal((await memory.search("npm")).length, 1);

  memory.delete(created.id);
  assert.equal(memory.list().length, 0);
  assert.throws(
    () => memory.get(created.id),
    (error: unknown) => {
      return error instanceof MemoryServiceError && error.code === "NOT_FOUND";
    },
  );
});

test("memory 输入校验与本地向量回填", async () => {
  await assert.rejects(
    () => memory.create({ content: "   " }),
    (error: unknown) => error instanceof MemoryServiceError && error.code === "INVALID",
  );
  await assert.rejects(
    () => memory.create({ content: "x".repeat(2_001) }),
    (error: unknown) => error instanceof MemoryServiceError && error.code === "INVALID",
  );

  const created = await memory.create({ content: "长期项目使用 Fathom 作为名称。" });
  assert.equal(database.listMemoryEmbeddings("hash-ngram-v1").length, 1);
  const context = await memory.formatContext("Fathom 名称");
  assert.match(context, /相关长期记忆/u);
  assert.match(context, /Fathom/u);
  memory.delete(created.id);
});
