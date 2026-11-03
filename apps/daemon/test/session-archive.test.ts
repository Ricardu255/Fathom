import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-session-archive-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
});

after(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("归档的 Session 不出现在默认列表，恢复后重新出现", () => {
  const session = database.createSession({
    title: "待归档会话",
    workspaceRoot: join(root, "workspace"),
  });
  assert.equal(
    database.listSessions().some((item) => item.id === session.id),
    true,
  );

  assert.equal(database.archiveSession(session.id), true);
  assert.equal(
    database.listSessions().some((item) => item.id === session.id),
    false,
  );
  const archived = database.listSessions(true);
  const archivedSession = archived.find((item) => item.id === session.id);
  assert.ok(archivedSession !== undefined);
  assert.notEqual(archivedSession.archivedAt, null);

  assert.equal(database.restoreSession(session.id), true);
  const restored = database.getSession(session.id);
  assert.ok(restored !== null);
  assert.equal(restored.archivedAt, null);
  assert.equal(
    database.listSessions().some((item) => item.id === session.id),
    true,
  );
  assert.equal(database.restoreSession(session.id), false);
});

test("Session 记录父会话关系", () => {
  const parent = database.createSession({
    title: "父会话",
    workspaceRoot: join(root, "workspace"),
  });
  const child = database.createSession({
    parentSessionId: parent.id,
    title: "子会话",
    workspaceRoot: join(root, "workspace"),
  });
  assert.equal(database.getSession(child.id)?.parentSessionId, parent.id);
  assert.equal(database.getSession(parent.id)?.parentSessionId, null);
});
