import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { evaluateRetrieval, recallAtK, reciprocalRank } from "../src/evaluation/retrieval-eval";
import { MemoryService } from "../src/memory/memory-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let memory: MemoryService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-retrieval-eval-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
  memory = new MemoryService({ database });
  await memory.initialize();
});

after(async () => {
  database.close();
  await rm(root, { force: true, recursive: true });
});

test("recallAtK 按相关文档的覆盖比例计算", () => {
  assert.equal(recallAtK(["a", "b", "c"], ["a"], 1), 1);
  assert.equal(recallAtK(["a", "b", "c"], ["c"], 1), 0);
  assert.equal(recallAtK(["a", "b", "c"], ["a", "c"], 3), 1);
  assert.equal(recallAtK(["a", "b", "c"], ["a", "z"], 3), 0.5);
  assert.equal(recallAtK([], ["a"], 3), 0);
  assert.equal(recallAtK(["a"], [], 3), 0);
});

test("reciprocalRank 取第一个相关结果的位置", () => {
  assert.equal(reciprocalRank(["x", "y"], ["x"]), 1);
  assert.equal(reciprocalRank(["x", "y"], ["y"]), 0.5);
  assert.equal(reciprocalRank(["x"], ["z"]), 0);
  assert.equal(reciprocalRank([], ["z"]), 0);
});

test("空查询集不会除零", async () => {
  const metrics = await evaluateRetrieval({ cases: [], search: () => [] });
  assert.deepEqual(metrics, {
    cases: 0,
    misses: [],
    mrr: 0,
    recallAt1: 0,
    recallAt3: 0,
    recallAtK: 0,
  });
});

test("运行器汇总多个用例并记录完全没命中的查询", async () => {
  const corpus: Record<string, string[]> = {
    构建: ["doc-build"],
    测试: ["doc-test"],
    无关问题: [],
  };
  const metrics = await evaluateRetrieval({
    cases: [
      { query: "构建", relevant: ["doc-build"] },
      { query: "测试", relevant: ["doc-test"] },
      { query: "无关问题", relevant: ["doc-build"] },
    ],
    k: 3,
    search: (query) => corpus[query] ?? [],
  });
  assert.equal(metrics.cases, 3);
  assert.equal(metrics.recallAt1, 2 / 3);
  assert.equal(metrics.mrr, 2 / 3);
  assert.equal(metrics.misses.length, 1);
  assert.equal(metrics.misses[0]?.query, "无关问题");
});

test("对真实记忆服务跑一遍基线：同一主题必须排在第一", async () => {
  const build = await memory.create({
    content: "构建流程使用 pnpm workspace，产物落在 apps 目录。",
    title: "构建笔记",
  });
  const testNote = await memory.create({
    content: "测试统一用 node 内置测试运行器，覆盖策略与事件存储。",
    title: "测试笔记",
  });
  await memory.create({
    content: "发布前需要检查安装包签名与版本号。",
    title: "发布笔记",
  });

  const metrics = await evaluateRetrieval({
    k: 3,
    cases: [
      { query: "pnpm workspace 构建", relevant: [`memory:${build.id}`] },
      { query: "node 内置测试运行器", relevant: [`memory:${testNote.id}`] },
    ],
    search: async (query) => {
      const hits = await memory.search(query, 3);
      return hits.map((hit) => hit.documentId);
    },
  });

  // 基线要求：召回 @3 满分，MRR 至少 0.5（允许一条排到第二）。
  assert.equal(metrics.recallAtK, 1, `未命中：${JSON.stringify(metrics.misses)}`);
  assert.ok(metrics.mrr >= 0.5, `MRR 过低：${metrics.mrr}`);
});
