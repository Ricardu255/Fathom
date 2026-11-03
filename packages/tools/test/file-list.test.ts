import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listWorkspaceEntries } from "../src/file-tools";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-workspace-files-"));
  await writeFile(join(root, "README.md"), "# demo\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "ignored.js"), "ignored\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("listWorkspaceEntries 返回结构化文件并忽略依赖目录", async () => {
  const result = await listWorkspaceEntries({ depth: 3, workspaceRoot: root });
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map((entry) => `${entry.type}:${entry.path}`).sort(), [
    "directory:src",
    "file:README.md",
    "file:src/index.ts",
  ]);
});

test("listWorkspaceEntries 拒绝越界路径并支持截断", async () => {
  await assert.rejects(listWorkspaceEntries({ depth: 2, path: "..", workspaceRoot: root }));
  const result = await listWorkspaceEntries({
    depth: 1,
    maxEntries: 1,
    workspaceRoot: root,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.truncated, true);
});
