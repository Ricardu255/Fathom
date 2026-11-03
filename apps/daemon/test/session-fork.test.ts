import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { copySessionEvents, findUserMessageSeq } from "../src/services/session-fork";
import { SessionEventStore } from "../src/storage/event-store";

const SOURCE = "session-source";
const TARGET = "session-target";
let root = "";
let events: SessionEventStore;
let seq = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-session-fork-"));
  events = new SessionEventStore({ directory: join(root, "sessions") });
  await events.initialize();
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function append(
  sessionId: string,
  type: HarnessEvent["type"],
  data: unknown,
  runId: string | null = "run-1",
): Promise<void> {
  seq += 1;
  await events.append({
    data,
    id: randomUUID(),
    runId,
    seq,
    sessionId,
    timestamp: Date.now(),
    type,
  });
}

test("复制会话时重写 sessionId/seq，并关闭未决审批", async () => {
  await append(SOURCE, HarnessEventType.RUN_STARTED, { model: "mock", tools: [] });
  await append(SOURCE, HarnessEventType.APPROVAL_REQUESTED, {
    approvalId: "approval-open",
    input: { path: "a.ts" },
    summary: "写入 a.ts",
    toolCallId: "tool-1",
    toolName: "write_file",
  });
  await append(SOURCE, HarnessEventType.APPROVAL_REQUESTED, {
    approvalId: "approval-closed",
    input: { command: "npm test" },
    summary: "执行测试",
    toolCallId: "tool-2",
    toolName: "run_command",
  });
  await append(SOURCE, HarnessEventType.APPROVAL_RESOLVED, {
    approvalId: "approval-closed",
    decision: "approved",
  });

  const lastSeq = await copySessionEvents(events, SOURCE, TARGET);
  const copied = await events.read(TARGET, 0);

  assert.equal(lastSeq, copied.at(-1)?.seq);
  assert.ok(copied.length >= 5);
  assert.ok(copied.every((event) => event.sessionId === TARGET));
  assert.deepEqual(
    copied.map((event) => event.seq),
    copied.map((_, index) => index + 1),
  );
  assert.notEqual(copied[0]?.id, (await events.read(SOURCE, 0))[0]?.id);

  const sourceApprovals = await events.read(SOURCE, 0);
  const copiedApprovals = copied.filter(
    (event) => event.type === HarnessEventType.APPROVAL_RESOLVED,
  );
  assert.equal(
    sourceApprovals.filter((event) => event.type === HarnessEventType.APPROVAL_RESOLVED).length,
    1,
  );
  assert.equal(copiedApprovals.length, 2);
  assert.ok(
    copiedApprovals.some(
      (event) =>
        (event.data as { approvalId?: string; decision?: string }).approvalId === "approval-open" &&
        (event.data as { decision?: string }).decision === "denied",
    ),
  );
});

test("复制空会话返回 0 且不写文件", async () => {
  assert.equal(await copySessionEvents(events, "empty-source", "empty-target"), 0);
  assert.deepEqual(await events.read("empty-target", 0), []);
});

test("可以按用户消息 cutoff 截断复制，并定位消息 seq", async () => {
  const source = "session-cutoff-source";
  const target = "session-cutoff-target";
  await append(source, HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, "run-a");
  await append(
    source,
    HarnessEventType.MESSAGE_COMPLETED,
    {
      message: {
        content: [{ text: "第一条", type: "text" }],
        role: "user",
        timestamp: 111,
      },
    },
    "run-a",
  );
  await append(
    source,
    HarnessEventType.MESSAGE_COMPLETED,
    {
      message: {
        content: [{ text: "第二条", type: "text" }],
        role: "user",
        timestamp: 222,
      },
    },
    "run-a",
  );
  const sourceEvents = await events.read(source, 0);
  const cutoff = findUserMessageSeq(sourceEvents, 111);
  assert.ok(cutoff !== undefined && cutoff !== null);
  assert.equal(findUserMessageSeq(sourceEvents, 999), null);

  const lastSeq = await copySessionEvents(events, source, target, cutoff);
  const copied = await events.read(target, 0);
  assert.equal(lastSeq, copied.length);
  assert.deepEqual(
    copied.map((event) => event.seq),
    sourceEvents.filter((event) => event.seq <= cutoff).map((_, index) => index + 1),
  );
  assert.equal(
    copied.some(
      (event) => (event.data as { message?: { timestamp?: number } }).message?.timestamp === 222,
    ),
    false,
  );
});
