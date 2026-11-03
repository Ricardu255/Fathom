import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Tool } from "@harness/core";
import { resolveWorkspacePath } from "@harness/policy";
import { toPiTools } from "../src/pi/tools";
import {
  assertObservedUnchanged,
  hashContent,
  WorkspaceWriteCoordinator,
} from "../src/pi/workspace-write-coordinator";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-write-coordinator-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("同一路径的写入串行，不同路径可并行", async () => {
  const coordinator = new WorkspaceWriteCoordinator();
  const order: string[] = [];
  await Promise.all([
    coordinator.withLock("a", undefined, async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    }),
    coordinator.withLock("a", undefined, async () => {
      order.push("b-start");
      order.push("b-end");
    }),
    coordinator.withLock("c", undefined, async () => {
      order.push("c-start");
      await delay(5);
      order.push("c-end");
    }),
  ]);
  assert.deepEqual(order.slice(0, 3), ["a-start", "c-start", "c-end"]);
  assert.deepEqual(order.slice(3), ["a-end", "b-start", "b-end"]);
});

test("目标内容变化后 observed-content 校验拒绝写入", async () => {
  const coordinator = new WorkspaceWriteCoordinator();
  const path = join(root, "observed.txt");
  await writeFile(path, "before", "utf8");
  coordinator.observe(path, hashContent("before"));
  await assertObservedUnchanged(coordinator, path);

  await writeFile(path, "external", "utf8");
  await assert.rejects(() => assertObservedUnchanged(coordinator, path), /WORKSPACE_CHANGED/u);
});

test("toPiTools 在写入前检查模型读到的内容指纹", async () => {
  const coordinator = new WorkspaceWriteCoordinator();
  const path = join(root, "guarded.txt");
  await writeFile(path, "before", "utf8");
  const absolutePath = await resolveWorkspacePath({ path, workspaceRoot: root });

  const readTool: Tool = {
    description: "read",
    execute: async () => ({
      content: "before",
      observedFiles: [{ hash: hashContent("before"), path: absolutePath }],
    }),
    inputSchema: { type: "object" },
    name: "read_file",
    parse: (input) => input,
    requiresApproval: false,
    summarize: () => "read",
  };
  let writes = 0;
  const writeTool: Tool = {
    description: "write",
    execute: async () => {
      writes += 1;
      return { content: "written" };
    },
    inputSchema: { type: "object" },
    name: "write_file",
    parse: (input) => input,
    requiresApproval: false,
    summarize: () => "write",
  };

  const definitions = toPiTools([readTool, writeTool], {
    onResult: () => undefined,
    requestApproval: async () => true,
    workspaceRoot: root,
    writeCoordinator: coordinator,
  });
  const read = definitions.find((definition) => definition.name === "read_file");
  const write = definitions.find((definition) => definition.name === "write_file");
  assert.notEqual(read, undefined);
  assert.notEqual(write, undefined);

  const readResult = await read?.execute(
    "read-1",
    { path: "guarded.txt" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(readResult?.isError, undefined);

  await writeFile(path, "external change", "utf8");
  const writeResult = await write?.execute(
    "write-1",
    { content: "new", path: "guarded.txt" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(writeResult?.isError, true);
  assert.match(JSON.stringify(writeResult?.content), /WORKSPACE_CHANGED/u);
  assert.equal(writes, 0);
});
