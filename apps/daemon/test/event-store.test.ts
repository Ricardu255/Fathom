import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { SessionEventStore } from "../src/storage/event-store";

let directory: string;
let store: SessionEventStore;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-events-"));
  store = new SessionEventStore({ directory });
  await store.initialize();
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function makeEvent(
  seq: number,
  sessionId = "session-1",
  type = HarnessEventType.RUN_STARTED,
): HarnessEvent {
  return {
    data: null,
    id: `event-${seq}`,
    runId: "run-1",
    seq,
    sessionId,
    timestamp: 1_000 + seq,
    type,
  };
}

test("append and read preserve order and support afterSeq", async () => {
  await store.append(makeEvent(1));
  await store.append(makeEvent(2));
  await store.append(makeEvent(3));
  const all = await store.read("session-1");
  assert.deepEqual(
    all.map((event) => event.seq),
    [1, 2, 3],
  );
  const tail = await store.read("session-1", 1);
  assert.deepEqual(
    tail.map((event) => event.seq),
    [2, 3],
  );
  assert.equal(await store.maxSeq("session-1"), 3);
});

test("a partial trailing line is ignored until it is complete", async () => {
  await writeFile(
    join(directory, "session-2.jsonl"),
    `${JSON.stringify(makeEvent(1, "session-2"))}\n`,
  );
  await appendFile(join(directory, "session-2.jsonl"), '{"seq":2,"sessionId":"session-');
  const pending = await store.read("session-2");
  assert.deepEqual(
    pending.map((event) => event.seq),
    [1],
  );
  await store.repairTrailingLine("session-2");
  const raw = await readFile(join(directory, "session-2.jsonl"), "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw.includes('"seq":2'), false);
});

test("a complete JSON line without a trailing newline is recovered by repair", async () => {
  await writeFile(
    join(directory, "session-3.jsonl"),
    `${JSON.stringify(makeEvent(1, "session-3"))}\n${JSON.stringify(makeEvent(2, "session-3"))}`,
  );
  const recovered = await store.read("session-3");
  assert.deepEqual(
    recovered.map((event) => event.seq),
    [1, 2],
  );
  await store.repairTrailingLine("session-3");
  const raw = await readFile(join(directory, "session-3.jsonl"), "utf8");
  assert.ok(raw.endsWith("\n"));
});

test("corrupt middle lines are skipped without blocking later events", async () => {
  const body = [
    JSON.stringify(makeEvent(1, "session-4")),
    "{not-json",
    JSON.stringify(makeEvent(3, "session-4")),
    "",
  ].join("\n");
  await writeFile(join(directory, "session-4.jsonl"), body);
  const events = await store.read("session-4");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 3],
  );

  // 损坏行不能只打一条 warning 就消失：原始行要留在旁边的隔离文件里。
  const quarantined = await readFile(join(directory, "session-4.corrupt.jsonl"), "utf8");
  const records = quarantined
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { index: number; line: string });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.line, "{not-json");
  assert.equal(records[0]?.index, 1);
});

test("重复读取不会重复隔离同一行", async () => {
  await store.read("session-4");
  await store.read("session-4");
  const quarantined = await readFile(join(directory, "session-4.corrupt.jsonl"), "utf8");
  assert.equal(quarantined.trim().split("\n").length, 1);
});

test("non-increasing sequences are ignored", async () => {
  await writeFile(
    join(directory, "session-5.jsonl"),
    `${JSON.stringify(makeEvent(2, "session-5"))}\n${JSON.stringify(makeEvent(2, "session-5"))}\n`,
  );
  const events = await store.read("session-5");
  assert.deepEqual(
    events.map((event) => event.seq),
    [2],
  );
});

test("新事件文件写入 schema 版本头，读取时把它当元数据而不是事件", async () => {
  await store.append(makeEvent(1, "session-6"));
  await store.append(makeEvent(2, "session-6"));

  const events = await store.read("session-6");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2],
  );

  const raw = await readFile(join(directory, "session-6.jsonl"), "utf8");
  const header = JSON.parse(raw.split("\n")[0] ?? "") as { type: string; schemaVersion: number };
  assert.equal(header.type, "session.header");
  assert.equal(header.schemaVersion, 1);

  // 头部不能被当成损坏行隔离。
  await assert.rejects(
    () => readFile(join(directory, "session-6.corrupt.jsonl"), "utf8"),
    /ENOENT/u,
  );
});

test("没有文件头的旧文件仍可回放", async () => {
  await writeFile(
    join(directory, "session-7.jsonl"),
    `${JSON.stringify(makeEvent(1, "session-7"))}\n${JSON.stringify(makeEvent(2, "session-7"))}\n`,
  );
  const events = await store.read("session-7");
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2],
  );
});
