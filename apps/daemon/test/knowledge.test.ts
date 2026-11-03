import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { KnowledgeHit, KnowledgeSearch, ToolContext } from "@harness/core";
import { searchKnowledgeTool } from "@harness/tools";
import { HarnessDatabase } from "../src/storage/database";

const DOCUMENT_ID = "doc-staged-reasoning";
const SOURCE_ID = "literature-1";
const DOCUMENT_TITLE = "分阶段推理论文（Staged Reasoning）";

interface ChunkInput {
  content: string;
  id: string;
  ordinal: number;
  pageEnd: number;
  pageStart: number;
  section: string | null;
}

const CHUNKS: readonly ChunkInput[] = [
  {
    content: "The staged pipeline combines retrieval and multistep reasoning for reliable answers.",
    id: "chunk-en",
    ordinal: 0,
    pageEnd: 2,
    pageStart: 1,
    section: "Introduction",
  },
  {
    content: "我们提出分阶段推理框架：先检索证据，再进行多步验证。",
    id: "chunk-zh",
    ordinal: 1,
    pageEnd: 3,
    pageStart: 3,
    section: "方法",
  },
  {
    content: "实验结果：该方法在三个基准上优于基线。",
    id: "chunk-mixed",
    ordinal: 2,
    pageEnd: 5,
    pageStart: 4,
    section: "Experiments",
  },
];

function indexDocument(
  database: HarnessDatabase,
  chunks: readonly ChunkInput[],
  title = DOCUMENT_TITLE,
): void {
  database.indexKnowledgeDocument(
    { id: DOCUMENT_ID, kind: "literature", sourceId: SOURCE_ID, title },
    chunks,
  );
}

async function createTemporaryDatabase(): Promise<{ database: HarnessDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-"));
  const database = new HarnessDatabase(join(root, "harness.sqlite"));
  return { database, root };
}

test("启动时 migration 4/5 创建 FTS5 知识表与任务看板表", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-knowledge-migration-"));
  const databasePath = join(root, "harness.sqlite");
  const database = new HarnessDatabase(databasePath);
  database.close();

  const inspect = new DatabaseSync(databasePath);
  try {
    const versionRow = inspect.prepare("SELECT MAX(version) AS version FROM schema_meta").get();
    assert.ok(versionRow !== undefined, "schema_meta 应存在版本记录");
    assert.equal(Number(versionRow.version), 16);

    for (const table of [
      "knowledge_documents",
      "knowledge_chunks",
      "knowledge_chunks_fts",
      "knowledge_embeddings",
      "board_tasks",
      "session_messages_fts",
    ]) {
      const row = inspect
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      assert.ok(row !== undefined, `应创建表 ${table}`);
    }

    const ftsRow = inspect
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'",
      )
      .get();
    assert.ok(ftsRow !== undefined);
    assert.match(String(ftsRow.sql), /fts5/iu);
    assert.match(String(ftsRow.sql), /trigram/iu);

    const indexRow = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("knowledge_chunks_document_idx");
    assert.ok(indexRow !== undefined, "应创建 knowledge_chunks_document_idx");
  } finally {
    inspect.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("indexKnowledgeDocument 写入并可按中英文/短查询检索", async () => {
  const { database, root } = await createTemporaryDatabase();
  try {
    indexDocument(database, CHUNKS);
    assert.equal(database.hasKnowledgeDocument(DOCUMENT_ID), true);

    // 英文短语查询命中 FTS5 trigram chunk。
    const englishHits = database.searchKnowledge("staged pipeline");
    assert.equal(englishHits.length, 1);
    const english = englishHits[0];
    assert.ok(english !== undefined);
    assert.equal(english.chunkId, "chunk-en");
    assert.equal(english.documentId, DOCUMENT_ID);
    assert.equal(english.documentTitle, DOCUMENT_TITLE);
    assert.equal(english.kind, "literature");
    assert.equal(english.sourceId, SOURCE_ID);
    assert.equal(english.pageStart, 1);
    assert.equal(english.pageEnd, 2);
    assert.equal(english.section, "Introduction");
    assert.equal(english.content, CHUNKS[0]?.content);

    // 中文短语查询命中中文 chunk。
    const chineseHits = database.searchKnowledge("分阶段推理");
    assert.equal(chineseHits.length, 1);
    const chinese = chineseHits[0];
    assert.ok(chinese !== undefined);
    assert.equal(chinese.chunkId, "chunk-zh");
    assert.equal(chinese.documentTitle, DOCUMENT_TITLE);
    assert.equal(chinese.pageStart, 3);
    assert.equal(chinese.pageEnd, 3);
    assert.equal(chinese.section, "方法");
    assert.equal(chinese.content, CHUNKS[1]?.content);

    // 少于 3 个字符的查询走 LIKE 回退，仍能命中。
    const shortHits = database.searchKnowledge("推理");
    assert.equal(shortHits.length, 1);
    assert.equal(shortHits[0]?.chunkId, "chunk-zh");

    // 空白查询与无关键词查询返回空。
    assert.deepEqual(database.searchKnowledge("   "), []);
    assert.deepEqual(database.searchKnowledge("nonexistent-term"), []);
  } finally {
    database.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("重新 index 同一 document 会替换旧 chunks 且不产生重复命中", async () => {
  const { database, root } = await createTemporaryDatabase();
  try {
    indexDocument(database, CHUNKS);
    assert.equal(database.searchKnowledge("staged pipeline").length, 1);

    const replacement: readonly ChunkInput[] = [
      {
        content: "A refreshed passage about distributed systems and consensus.",
        id: "chunk-replacement",
        ordinal: 0,
        pageEnd: 11,
        pageStart: 10,
        section: "Updated",
      },
    ];
    indexDocument(database, replacement);
    assert.equal(database.hasKnowledgeDocument(DOCUMENT_ID), true);

    // 旧内容与旧 chunk 全部被替换。
    assert.deepEqual(database.searchKnowledge("staged pipeline"), []);
    assert.deepEqual(database.searchKnowledge("分阶段推理"), []);
    assert.deepEqual(database.searchKnowledge("实验结果"), []);

    // 新内容只命中一次，说明没有残留或重复的 FTS 行。
    const hits = database.searchKnowledge("distributed systems");
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.equal(hit.chunkId, "chunk-replacement");
    assert.equal(hit.pageStart, 10);
    assert.equal(hit.pageEnd, 11);
    assert.equal(hit.section, "Updated");
    assert.equal(hit.content, replacement[0]?.content);
  } finally {
    database.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("deleteKnowledgeDocument 后文档与检索结果都消失", async () => {
  const { database, root } = await createTemporaryDatabase();
  try {
    indexDocument(database, CHUNKS);
    assert.equal(database.hasKnowledgeDocument(DOCUMENT_ID), true);
    assert.equal(database.searchKnowledge("staged pipeline").length, 1);

    database.deleteKnowledgeDocument(DOCUMENT_ID);

    assert.equal(database.hasKnowledgeDocument(DOCUMENT_ID), false);
    assert.deepEqual(database.searchKnowledge("staged pipeline"), []);
    assert.deepEqual(database.searchKnowledge("分阶段推理"), []);
    assert.deepEqual(database.searchKnowledge("推理"), []);
    assert.deepEqual(database.searchKnowledge("实验结果"), []);

    // 删除不存在的 document 不应抛错。
    database.deleteKnowledgeDocument(DOCUMENT_ID);
    assert.equal(database.hasKnowledgeDocument(DOCUMENT_ID), false);
  } finally {
    database.close();
    await rm(root, { force: true, recursive: true });
  }
});

const TOOL_HITS: readonly KnowledgeHit[] = [
  {
    chunkId: "hit-1",
    content: "Alpha content about the staged pipeline.",
    documentId: "doc-one",
    documentTitle: "Doc One",
    kind: "literature",
    pageEnd: 5,
    pageStart: 3,
    section: "Methods",
    sourceId: "source-one",
  },
  {
    chunkId: "hit-2",
    content: "Beta content 中文片段。",
    documentId: "doc-two",
    documentTitle: "Doc Two",
    kind: "workspace",
    pageEnd: 9,
    pageStart: 9,
    section: null,
    sourceId: null,
  },
];

const TOOL_SIGNAL = new AbortController().signal;
const TOOL_WORKSPACE = process.cwd();

function contextWith(searchKnowledge: KnowledgeSearch): ToolContext {
  return { searchKnowledge, signal: TOOL_SIGNAL, workspaceRoot: TOOL_WORKSPACE };
}

function contextWithoutSearch(): ToolContext {
  return { signal: TOOL_SIGNAL, workspaceRoot: TOOL_WORKSPACE };
}

test("searchKnowledgeTool 输出标题、页码、章节与片段内容", async () => {
  const calls: { limit: number; query: string; signal: AbortSignal | undefined }[] = [];
  const context = contextWith(async (query, limit, signal) => {
    calls.push({ limit, query, signal });
    return TOOL_HITS;
  });

  const result = await searchKnowledgeTool.execute({ query: "staged pipeline" }, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.query, "staged pipeline");
  assert.equal(calls[0]?.limit, 8);
  assert.equal(calls[0]?.signal, TOOL_SIGNAL);

  assert.match(result.content, /Doc One/u);
  assert.match(result.content, /p\.3-5/u);
  assert.match(result.content, /Methods/u);
  assert.match(result.content, /Alpha content/u);

  assert.match(result.content, /Doc Two/u);
  assert.match(result.content, /p\.9/u);
  assert.doesNotMatch(result.content, /p\.9-/u);
  assert.match(result.content, /Beta content 中文片段/u);
});

test("searchKnowledgeTool 无命中时输出 (no matches)", async () => {
  const result = await searchKnowledgeTool.execute(
    { query: "nothing" },
    contextWith(async () => []),
  );
  assert.equal(result.content, "(no matches)");
});

test("searchKnowledgeTool 未注入检索能力时拒绝执行", async () => {
  await assert.rejects(
    searchKnowledgeTool.execute({ query: "anything" }, contextWithoutSearch()),
    /没有可用的知识库检索能力/u,
  );
});

test("searchKnowledgeTool 参数校验拒绝空 query 与越界 limit", async () => {
  const context = contextWith(async () => []);

  await assert.rejects(searchKnowledgeTool.execute({ query: "" }, context));
  await assert.rejects(searchKnowledgeTool.execute({ query: "valid", limit: 0 }, context));
  await assert.rejects(searchKnowledgeTool.execute({ query: "valid", limit: 21 }, context));
  await assert.rejects(searchKnowledgeTool.execute({ query: "valid", limit: 1.5 }, context));
  await assert.rejects(searchKnowledgeTool.execute({ query: "x".repeat(501), limit: 8 }, context));

  // 边界值 1 与 20 应被接受。
  assert.equal(
    (await searchKnowledgeTool.execute({ query: "valid", limit: 1 }, context)).content,
    "(no matches)",
  );
  assert.equal(
    (await searchKnowledgeTool.execute({ query: "valid", limit: 20 }, context)).content,
    "(no matches)",
  );
});
