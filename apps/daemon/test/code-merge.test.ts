import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { applyCodeMerge, previewCodeMerge } from "../src/services/code-merge";
import { WorkspaceService } from "../src/services/workspace-service";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-code-merge-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function fileEvent(
  path: string,
  before: string | null,
  after: string | null,
  seq: number,
): HarnessEvent {
  return {
    data: { after, before, diff: "", path },
    id: `event-${seq}`,
    runId: "run-1",
    seq,
    sessionId: "session-1",
    timestamp: seq,
    type: HarnessEventType.FILE_CHANGED,
  };
}

test("三方合并可以合并不同行修改", () => {
  const ours = [fileEvent("src/a.ts", "a\nb\nc\nd\n", "a\nB\nc\nd\n", 1)];
  const theirs = [fileEvent("src/a.ts", "a\nb\nc\nd\n", "a\nb\nc\nD\n", 2)];
  const preview = previewCodeMerge(ours, theirs);
  assert.equal(preview.length, 1);
  assert.equal(preview[0]?.conflict, false);
  assert.equal(preview[0]?.merged, "a\nB\nc\nD\n");
});

test("同一行修改与删除/修改会标记冲突", () => {
  const ours = [fileEvent("src/a.ts", "a\nb\n", "a\nOURS\n", 1)];
  const theirs = [fileEvent("src/a.ts", "a\nb\n", "a\nTHEIRS\n", 2)];
  const conflict = previewCodeMerge(ours, theirs);
  assert.equal(conflict[0]?.conflict, true);

  const deleted = [fileEvent("src/a.ts", "a\n", null, 3)];
  const modified = [fileEvent("src/a.ts", "a\n", "a\nb\n", 4)];
  const deletionConflict = previewCodeMerge(deleted, modified);
  assert.equal(deletionConflict[0]?.conflict, true);
});

test("applyCodeMerge 写入合并且拒绝冲突文件", async () => {
  await writeFile(join(root, "a.ts"), "old\n");
  const workspace = new WorkspaceService({ protectedPaths: [join(root, ".data")] });
  await applyCodeMerge(
    [
      {
        base: "old\n",
        conflict: false,
        merged: "new\n",
        ours: "old\n",
        path: "a.ts",
        theirs: "new\n",
      },
    ],
    workspace,
    root,
  );
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "new\n");

  await assert.rejects(
    applyCodeMerge(
      [
        {
          base: "old\n",
          conflict: true,
          merged: "conflict\n",
          ours: "ours\n",
          path: "a.ts",
          theirs: "theirs\n",
        },
      ],
      workspace,
      root,
    ),
  );
});
