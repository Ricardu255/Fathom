import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { assessCommand, isPathWithin, PathPolicyError, resolveWorkspacePath } from "../src/index";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-policy-"));
  await mkdir(join(root, "workspace", "src"), { recursive: true });
  await writeFile(join(root, "workspace", "src", "a.ts"), "export const a = 1;\n");
  await mkdir(join(root, "protected"), { recursive: true });
  await writeFile(join(root, "protected", "secret.txt"), "secret\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("isPathWithin accepts the root and descendants, rejects siblings", () => {
  const workspace = join(root, "workspace");
  assert.equal(isPathWithin(workspace, workspace), true);
  assert.equal(isPathWithin(workspace, join(workspace, "src", "a.ts")), true);
  assert.equal(isPathWithin(workspace, join(root, "protected")), false);
});

test("resolveWorkspacePath resolves relative and absolute in-workspace paths", async () => {
  const workspaceRoot = join(root, "workspace");
  const relativePath = await resolveWorkspacePath({ workspaceRoot, path: "src/a.ts" });
  assert.equal(relativePath, join(workspaceRoot, "src", "a.ts"));
  const absolutePath = await resolveWorkspacePath({
    workspaceRoot,
    path: join(workspaceRoot, "src", "a.ts"),
  });
  assert.equal(absolutePath, relativePath);
});

test("resolveWorkspacePath rejects traversal and protected paths", async () => {
  const workspaceRoot = join(root, "workspace");
  await assert.rejects(
    resolveWorkspacePath({ workspaceRoot, path: "../protected/secret.txt" }),
    (error: unknown) => error instanceof PathPolicyError && error.code === "OUTSIDE_WORKSPACE",
  );
  await assert.rejects(
    resolveWorkspacePath({
      workspaceRoot,
      path: join(root, "protected", "secret.txt"),
    }),
    (error: unknown) => error instanceof PathPolicyError && error.code === "OUTSIDE_WORKSPACE",
  );
  await assert.rejects(
    resolveWorkspacePath({
      workspaceRoot,
      path: "src/a.ts",
      protectedPaths: [join(workspaceRoot, "src")],
    }),
    (error: unknown) => error instanceof PathPolicyError && error.code === "PROTECTED",
  );
});

test("resolveWorkspacePath allows missing paths only when requested", async () => {
  const workspaceRoot = join(root, "workspace");
  await assert.rejects(
    resolveWorkspacePath({ workspaceRoot, path: "src/new/deep/file.ts" }),
    PathPolicyError,
  );
  const created = await resolveWorkspacePath({
    workspaceRoot,
    path: "src/new/deep/file.ts",
    allowMissing: true,
  });
  assert.equal(created, join(workspaceRoot, "src", "new", "deep", "file.ts"));
});

test("assessCommand always requires approval and flags destructive commands", () => {
  assert.equal(assessCommand("ls -la").requiresApproval, true);
  assert.equal(assessCommand("ls -la").destructive, false);
  assert.equal(assessCommand("rm -rf ./src").destructive, true);
  assert.throws(() => assessCommand("   "), PathPolicyError);
});
