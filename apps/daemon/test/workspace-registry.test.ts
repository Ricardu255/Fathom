import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WorkspaceRegistryService } from "../src/services/workspace-registry-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let workspaces: WorkspaceRegistryService;
let workspaceA = "";
let workspaceB = "";
let dataDir = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-workspaces-"));
  workspaceA = join(root, "workspace-a");
  workspaceB = join(root, "workspace-b");
  dataDir = join(root, "data");
  await mkdir(workspaceA, { recursive: true });
  await mkdir(workspaceB, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  database = new HarnessDatabase(join(dataDir, "harness.sqlite"));
  workspaces = new WorkspaceRegistryService({
    database,
    protectedPaths: [dataDir],
  });
});

after(async () => {
  database.close();
  await rm(root, { force: true, recursive: true });
});

test("添加、排序、重命名与软移除工作区", async () => {
  const first = await workspaces.add(workspaceA);
  const second = await workspaces.add(workspaceB, "项目 B");
  assert.equal(first.displayName, "workspace-a");
  assert.equal(second.displayName, "项目 B");
  assert.equal((await workspaces.list()).length, 2);

  const renamed = await workspaces.rename(second.id, "项目 B2");
  assert.equal(renamed.displayName, "项目 B2");

  const reordered = await workspaces.reorder([second.id, first.id]);
  assert.deepEqual(
    reordered.map((workspace) => workspace.id),
    [second.id, first.id],
  );

  workspaces.remove(second.id);
  assert.equal((await workspaces.list()).length, 1);
  assert.equal((await workspaces.list(true)).length, 2);

  const restored = await workspaces.add(workspaceB);
  assert.equal(restored.id, second.id);
  assert.equal(restored.removedAt, null);
  assert.equal((await workspaces.list()).length, 2);
});

test("创建会话会绑定 workspaceId，未知工作区不能解析", async () => {
  const workspace = (await workspaces.list()).find((item) => item.rootPath === workspaceA);
  assert.ok(workspace !== undefined);
  const session = database.createSession({ title: "workspace session", workspaceRoot: workspaceA });
  assert.equal(session.workspaceId, workspace.id);
  assert.equal(workspaces.requireRoot(workspace.id), workspaceA);
  assert.throws(() => workspaces.requireRoot("missing"), /工作区不存在/);
});

test("拒绝把 daemon 数据目录登记为工作区", async () => {
  await assert.rejects(() => workspaces.add(dataDir), /不能与 daemon 数据目录重叠/);
});

test("命令前缀授权可持久化、去重与撤销", () => {
  assert.equal(database.addAllowedCommandPrefix("git status").includes("git status"), true);
  assert.deepEqual(database.listAllowedCommandPrefixes(), ["git status"]);
  database.addAllowedCommandPrefix("git status");
  assert.deepEqual(database.listAllowedCommandPrefixes(), ["git status"]);
  assert.deepEqual(database.removeAllowedCommandPrefix("git status"), []);
});
