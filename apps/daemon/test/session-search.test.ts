import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessDatabase } from "../src/storage/database";

test("Session FTS 支持中英文检索、短查询回退并排除归档会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "fathom-session-search-"));
  const database = new HarnessDatabase(join(root, "harness.sqlite"));
  try {
    const active = database.createSession({ title: "登录问题", workspaceRoot: root });
    database.indexSessionMessage({
      content: "登录接口需要补充错误处理。",
      role: "user",
      seq: 1,
      sessionId: active.id,
      timestamp: 1_000,
    });
    database.indexSessionMessage({
      content: "已经修复 src/auth.ts 的类型错误。",
      role: "assistant",
      seq: 2,
      sessionId: active.id,
      timestamp: 2_000,
    });
    const archived = database.createSession({ title: "归档会话", workspaceRoot: root });
    database.indexSessionMessage({
      content: "登录归档内容不应被搜索到。",
      role: "user",
      seq: 1,
      sessionId: archived.id,
      timestamp: 3_000,
    });
    database.archiveSession(archived.id);

    const shortHits = database.searchSessionMessages("登录");
    assert.equal(shortHits.length, 1);
    assert.equal(shortHits[0]?.sessionId, active.id);
    assert.equal(shortHits[0]?.role, "user");

    const trigramHits = database.searchSessionMessages("类型错误");
    assert.equal(trigramHits.length, 1);
    assert.equal(trigramHits[0]?.seq, 2);

    assert.equal(database.sessionMessageCount(), 3);
    database.clearSessionMessages(active.id);
    assert.equal(database.searchSessionMessages("登录").length, 0);
  } finally {
    database.close();
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
