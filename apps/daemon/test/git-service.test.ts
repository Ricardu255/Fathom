import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { GitService, GitServiceError } from "../src/services/git-service";

const run = promisify(execFile);
let root = "";
let service: GitService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-git-"));
  await run("git", ["init"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "Harness Test"], { cwd: root });
  service = new GitService();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("Git 状态、diff、暂存与提交", async () => {
  assert.equal((await service.status(root)).clean, true);

  await writeFile(join(root, "README.md"), "# demo\n");
  const dirty = await service.status(root);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.files[0]?.path, "README.md");
  assert.equal(dirty.files[0]?.staged, false);

  await service.stage(root, ["README.md"]);
  const staged = await service.status(root);
  assert.equal(staged.files[0]?.staged, true);
  assert.match(await service.diff(root, "README.md", true), /# demo/u);

  await service.commit(root, "initial commit");
  const clean = await service.status(root);
  assert.equal(clean.clean, true);
  assert.notEqual(clean.branch, "");
});

test("非 Git 工作区返回 NOT_REPO", async () => {
  const outside = await mkdtemp(join(tmpdir(), "harness-not-git-"));
  try {
    await assert.rejects(
      new GitService().status(outside),
      (error: unknown) => error instanceof GitServiceError && error.code === "NOT_REPO",
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
