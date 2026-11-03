import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { FileChangeService, FileChangeServiceError } from "../src/services/file-change-service";

function changed(
  path: string,
  before: string | null,
  after: string | null,
  seq: number,
): HarnessEvent {
  return {
    data: {
      after,
      before,
      diff: "-old\n+new",
      path,
      toolCallId: `t-${seq}`,
      toolName: "edit_file",
    },
    id: `event-${seq}`,
    runId: "run-1",
    seq,
    sessionId: "session-1",
    timestamp: 1_000 + seq,
    type: HarnessEventType.FILE_CHANGED,
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "fathom-file-change-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const service = new FileChangeService({ protectedPaths: [] });

test("撤销与重放跨多次变更回到最早 before / 最新 after", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "a.txt"), "v3", "utf8");
    const events = [changed("a.txt", "v1", "v2", 1), changed("a.txt", "v2", "v3", 2)];

    assert.deepEqual(await service.apply(workspace, events, ["a.txt"], "undo"), ["a.txt"]);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "v1");

    assert.deepEqual(await service.apply(workspace, events, ["a.txt"], "replay"), ["a.txt"]);
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "v3");
  });
});

test("多文件存在冲突时整体拒绝，不产生部分写入", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "a.txt"), "v2", "utf8");
    await writeFile(join(workspace, "b.txt"), "被人改过", "utf8");
    const events = [changed("a.txt", "v1", "v2", 1), changed("b.txt", "b1", "b2", 2)];

    await assert.rejects(
      () => service.apply(workspace, events, ["a.txt", "b.txt"], "undo"),
      (error: unknown) => error instanceof FileChangeServiceError && error.code === "CONFLICT",
    );
    assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "v2");
    assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "被人改过");
  });
});

test("新建文件撤销后删除，重放后恢复", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "new.txt"), "created", "utf8");
    const events = [changed("new.txt", null, "created", 1)];

    await service.apply(workspace, events, ["new.txt"], "undo");
    await assert.rejects(() => access(join(workspace, "new.txt")));

    await service.apply(workspace, events, ["new.txt"], "replay");
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "created");
  });
});

test("越界、缺失记录与空选择会被拒绝", async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(
      () => service.apply(workspace, [changed("a.txt", "v1", "v2", 1)], [], "undo"),
      (error: unknown) => error instanceof FileChangeServiceError && error.code === "INVALID",
    );
    await assert.rejects(
      () => service.apply(workspace, [changed("a.txt", "v1", "v2", 1)], ["missing.txt"], "undo"),
      (error: unknown) => error instanceof FileChangeServiceError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      () =>
        service.apply(
          workspace,
          [changed("../outside.txt", "v1", "v2", 1)],
          ["../outside.txt"],
          "undo",
        ),
      (error: unknown) => error instanceof FileChangeServiceError && error.code === "INVALID",
    );
  });
});
