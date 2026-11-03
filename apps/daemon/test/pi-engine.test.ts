import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type AgentMessage, type HarnessEvent, HarnessEventType, messageText } from "@harness/core";
import { type HarnessConfig, loadConfig } from "../src/config";
import { createPiModelSetup } from "../src/pi/model";
import { SessionEventBus } from "../src/services/event-bus";
import { PiSessionService } from "../src/services/pi-session-service";
import type { SessionSnapshot } from "../src/services/session-types";
import { HarnessDatabase, type SessionRecord } from "../src/storage/database";
import { SessionEventStore } from "../src/storage/event-store";

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 15_000;

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  HarnessEventType.RUN_COMPLETED,
  HarnessEventType.RUN_FAILED,
  HarnessEventType.RUN_ABORTED,
]);

interface TestContext {
  bus: SessionEventBus;
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  service: PiSessionService;
  session: SessionRecord;
  tempRoot: string;
  workspace: string;
}

let ctx: TestContext | undefined;

function context(): TestContext {
  if (ctx === undefined) throw new Error("测试上下文尚未初始化");
  return ctx;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 probe 返回非 undefined；超时抛出带标签的错误。 */
async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`等待超时（${POLL_TIMEOUT_MS}ms）: ${label}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function readAll(sessionId: string): Promise<HarnessEvent[]> {
  return context().service.readEvents(sessionId, 0);
}

async function currentSeq(sessionId: string): Promise<number> {
  return (await readAll(sessionId)).at(-1)?.seq ?? 0;
}

interface RunEnd {
  events: HarnessEvent[];
  snapshot: SessionSnapshot;
  terminal: HarnessEvent;
}

/** Run 结束 = snapshot 不再运行，且 afterSeq 之后已持久化终态事件。 */
async function waitForRunEnd(sessionId: string, afterSeq: number): Promise<RunEnd> {
  return waitFor("Run 到达终态", async () => {
    const snapshot = await context().service.getSnapshot(sessionId);
    if (snapshot.isRunning) return undefined;
    const events = await context().service.readEvents(sessionId, afterSeq);
    const terminal = events.find((event) => TERMINAL_EVENT_TYPES.has(event.type));
    return terminal === undefined ? undefined : { events, snapshot, terminal };
  });
}

function userTexts(messages: readonly AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message));
}

function eventTypes(events: readonly HarnessEvent[]): string[] {
  return events.map((event) => event.type);
}

before(async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "harness-pi-engine-"));
  const workspace = join(tempRoot, "workspace");
  const config = loadConfig({
    HARNESS_DATA_DIR: join(tempRoot, "data"),
    HARNESS_ENGINE: "pi",
    HARNESS_HOST: "127.0.0.1",
    HARNESS_MOCK_MODEL: "1",
    HARNESS_MODEL: "claude-sonnet-5-5",
    HARNESS_WORKSPACE: workspace,
  });
  const database = new HarnessDatabase(join(config.dataDir, "harness.sqlite"));
  const events = new SessionEventStore({ directory: config.sessionsDir });
  await events.initialize();
  const bus = new SessionEventBus();
  const modelSetup = await createPiModelSetup(config);
  const service = new PiSessionService({
    bus,
    config,
    database,
    events,
    logger: {
      error: (details, message) => console.error(`[pi-engine-test] ${message}`, details),
      warn: (details, message) => console.warn(`[pi-engine-test] ${message}`, details),
    },
    modelSetup,
  });
  await service.initialize();
  const session = await service.createSession({ title: "pi-engine-test" });
  ctx = { bus, config, database, events, service, session, tempRoot, workspace };
});

after(async () => {
  const current = ctx;
  ctx = undefined;
  if (current === undefined) return;
  await current.service.close();
  current.database.close();
  await rm(current.tempRoot, { recursive: true, force: true });
});

test("Mock 模式可以完成一次带工具调用的 Run", async () => {
  const { service, session, workspace } = context();
  const beforeSeq = await currentSeq(session.id);

  const started = await service.startRun(session.id, "列出当前工作区的文件");
  assert.equal(typeof started.runId, "string");
  assert.equal(started.queuedInputId, undefined);

  const { events, terminal } = await waitForRunEnd(session.id, beforeSeq);
  assert.equal(terminal.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(terminal.runId, started.runId);

  const types = eventTypes(events);
  for (const required of [
    HarnessEventType.RUN_STARTED,
    HarnessEventType.TOOL_STARTED,
    HarnessEventType.TOOL_COMPLETED,
    HarnessEventType.RUN_COMPLETED,
  ]) {
    assert.ok(types.includes(required), `事件流缺少 ${required}: ${types.join(", ")}`);
  }
  assert.ok(
    types.indexOf(HarnessEventType.RUN_STARTED) < types.indexOf(HarnessEventType.TOOL_STARTED),
    "run.started 应早于 tool.started",
  );
  assert.ok(
    types.indexOf(HarnessEventType.TOOL_STARTED) < types.indexOf(HarnessEventType.TOOL_COMPLETED),
    "tool.started 应早于 tool.completed",
  );
  assert.ok(
    types.indexOf(HarnessEventType.TOOL_COMPLETED) < types.indexOf(HarnessEventType.RUN_COMPLETED),
    "tool.completed 应早于 run.completed",
  );

  const requestSnapshot = events.find((event) => event.type === HarnessEventType.REQUEST_SNAPSHOT);
  assert.ok(requestSnapshot !== undefined, "每次模型请求应记录 request.snapshot");
  const snapshotData = requestSnapshot.data as {
    messages?: unknown[];
    systemPrompt?: string;
    tools?: Array<{ name?: string }>;
  };
  assert.match(snapshotData.systemPrompt ?? "", /Workspace root/u);
  assert.ok(snapshotData.tools?.some((tool) => tool.name === "list_files"));
  assert.ok((snapshotData.messages?.length ?? 0) > 0);

  const allEvents = await readAll(session.id);
  for (let index = 1; index < allEvents.length; index += 1) {
    const previous = allEvents[index - 1];
    const current = allEvents[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(
      current.seq > previous.seq,
      `事件 seq 必须严格递增：${previous.seq} -> ${current.seq}`,
    );
  }

  const snapshot = await service.getSnapshot(session.id);
  assert.ok(snapshot.messages.some((message) => message.role === "user"));
  assert.ok(snapshot.messages.some((message) => message.role === "assistant"));
  assert.ok(userTexts(snapshot.messages).includes("列出当前工作区的文件"));
  assert.ok(
    snapshot.tools.some(
      (tool) =>
        tool.name === "list_files" && tool.status === "completed" && tool.result !== undefined,
    ),
    "快照应恢复已结束会话的工具卡",
  );

  const toolCompleted = events.find((event) => event.type === HarnessEventType.TOOL_COMPLETED);
  assert.ok(toolCompleted !== undefined);
  const toolData = toolCompleted.data as { toolName?: unknown };
  assert.equal(toolData.toolName, "list_files");

  // 工作区应仍为空（list_files 只读）。
  await access(workspace);
});

test("写入文件会先请求审批，批准后产生 file.changed", async () => {
  const { service, session, workspace } = context();
  const beforeSeq = await currentSeq(session.id);

  const started = await service.startRun(session.id, "帮我创建一个文件");
  assert.equal(typeof started.runId, "string");

  const pendingEvents = await waitFor("approval.requested", async () => {
    const events = await service.readEvents(session.id, beforeSeq);
    return events.find((event) => event.type === HarnessEventType.APPROVAL_REQUESTED) === undefined
      ? undefined
      : events;
  });
  const requested = pendingEvents.find(
    (event) => event.type === HarnessEventType.APPROVAL_REQUESTED,
  );
  assert.ok(requested !== undefined);
  const approval = requested.data as { approvalId?: unknown; toolName?: unknown };
  assert.equal(typeof approval.approvalId, "string");
  assert.equal(approval.toolName, "write_file");

  assert.equal(service.resolveApproval(session.id, approval.approvalId as string, true), true);

  const { events, terminal } = await waitForRunEnd(session.id, beforeSeq);
  assert.equal(terminal.type, HarnessEventType.RUN_COMPLETED);
  const resolved = events.find((event) => event.type === HarnessEventType.APPROVAL_RESOLVED);
  assert.ok(resolved !== undefined);
  assert.deepEqual(resolved.data, {
    approvalId: approval.approvalId,
    decision: "approved",
  });

  const snapshot = await service.getSnapshot(session.id);
  assert.ok(snapshot.fileChanges.length >= 1, "fileChanges 至少应有一条");
  assert.ok(snapshot.fileChanges.some((change) => change.path === "mock-demo.txt"));
  await access(join(workspace, "mock-demo.txt"));
});

test("流式运行中提交的输入会排队并在当前 Run 结束后执行", async () => {
  const { service, session } = context();
  const beforeSeq = await currentSeq(session.id);
  const longPrompt = "请写一段很长的说明，介绍一下当前模式";
  const queuedPrompt = "列个待办";

  const first = await service.startRun(session.id, longPrompt);
  assert.equal(typeof first.runId, "string");
  assert.equal(first.queuedInputId, undefined);

  // 等到首个 Run 真正进入流式（run.started 已落盘），此时再提交才会走 followUp 队列。
  await waitFor("首个 Run 进入流式", async () => {
    const snapshot = await service.getSnapshot(session.id);
    if (!snapshot.isRunning) return undefined;
    const events = await service.readEvents(session.id, beforeSeq);
    return events.some((event) => event.type === HarnessEventType.RUN_STARTED) ? true : undefined;
  });

  const second = await service.startRun(session.id, queuedPrompt);
  assert.equal(typeof second.queuedInputId, "string", "运行中提交应返回 queuedInputId");
  assert.equal(second.runId, undefined);

  const { events, terminal } = await waitForRunEnd(session.id, beforeSeq);
  assert.equal(terminal.type, HarnessEventType.RUN_COMPLETED);

  const queuedMessage = events.find((event) => {
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) return false;
    return (event.data as { queuedInputId?: unknown }).queuedInputId === second.queuedInputId;
  });
  assert.ok(queuedMessage !== undefined, "排队输入的消息应携带 queuedInputId");

  const snapshot = await service.getSnapshot(session.id);
  assert.equal(snapshot.queued.length, 0, "Run 结束后队列应为空");
  assert.ok(snapshot.todos.length >= 3, "应产生至少 3 条待办");

  const texts = userTexts(snapshot.messages);
  assert.ok(texts.includes(longPrompt), "消息中应包含第一条用户输入");
  assert.ok(texts.includes(queuedPrompt), "消息中应包含排队后的第二条用户输入");
});

test("显式要求自主迭代时自动续轮，内部消息不出现在快照中", async () => {
  const { service, session } = context();
  const beforeSeq = await currentSeq(session.id);
  await service.startRun(session.id, "请自动续轮完成任务");
  const { events, terminal } = await waitForRunEnd(session.id, beforeSeq);
  assert.equal(terminal.type, HarnessEventType.RUN_COMPLETED);

  const snapshot = await service.getSnapshot(session.id);
  const texts = userTexts(snapshot.messages);
  assert.ok(texts.includes("请自动续轮完成任务"));
  assert.ok(
    !texts.some((text) => text.includes("Continue the autonomous task")),
    "内部续轮消息不应渲染",
  );
  const assistantTexts = snapshot.messages
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message));
  assert.ok(assistantTexts.includes("第一轮进行中。"));
  assert.ok(assistantTexts.includes("续轮完成。"));
  assert.ok(
    !assistantTexts.some((text) => text.includes("FATHOM_CONTINUE")),
    "续轮标记不应出现在 UI 消息中",
  );
  assert.ok(
    events.filter((event) => event.type === HarnessEventType.REQUEST_SNAPSHOT).length >= 2,
    "自动续轮应产生第二次模型请求",
  );
});

test("改写历史消息会从该消息之前创建新分支并重跑，旧分支保留", async () => {
  const { service, session } = context();
  const beforeSeq = await currentSeq(session.id);
  const original = `原始问题-${Date.now()}`;
  await service.startRun(session.id, original);
  await waitForRunEnd(session.id, beforeSeq);

  const originalEvents = await service.readEvents(session.id, beforeSeq);
  const originalMessage = originalEvents.find((event) => {
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) return false;
    const data = event.data as { message?: { role?: unknown; timestamp?: unknown } };
    return data.message?.role === "user";
  });
  assert.ok(originalMessage !== undefined);
  const timestamp = (originalMessage.data as { message: { timestamp: number } }).message.timestamp;

  const result = await service.rewriteSession(session.id, timestamp, "改写后的问题");
  assert.notEqual(result.session.id, session.id);
  assert.equal(result.session.parentSessionId, session.id);
  assert.equal(typeof result.runId, "string");

  await waitForRunEnd(result.session.id, 0);
  const rewritten = await service.getSnapshot(result.session.id);
  const texts = userTexts(rewritten.messages);
  assert.ok(texts.includes("改写后的问题"));
  assert.ok(!texts.includes(original));

  const sourceTexts = userTexts((await service.getSnapshot(session.id)).messages);
  assert.ok(sourceTexts.includes(original), "旧分支应保留原始消息");
});

test("历史检查点支持列表、对比与恢复", async () => {
  const { service, events } = context();
  const target = await service.createSession({ title: "checkpoint-test" });
  const checkpoint = {
    blockers: ["等待密钥"],
    completed: ["建表"],
    constraints: ["不新增依赖"],
    decisions: ["使用 JWT"],
    goal: "实现登录",
    nextSteps: ["写接口"],
    pending: ["写接口"],
  };
  await events.append({
    data: {
      afterTokens: 10,
      beforeTokens: 100,
      checkpoint,
      checkpointId: "cp-1",
      coveredFromSeq: 1,
      coveredToSeq: 1,
      previousCheckpointId: null,
      replacedMessages: 1,
      summary: "第一版检查点",
      trigger: "manual",
    },
    id: "checkpoint-event-1",
    runId: null,
    seq: 1,
    sessionId: target.id,
    timestamp: Date.now(),
    type: HarnessEventType.CONTEXT_COMPACTED,
  });

  const checkpoints = await service.listCheckpoints(target.id);
  assert.equal(checkpoints.length, 1);
  const stored = checkpoints[0];
  assert.ok(stored !== undefined);
  assert.equal(stored.checkpointId, "cp-1");
  assert.equal(stored.trigger, "manual");
  assert.deepEqual(stored.checkpoint, checkpoint);

  const comparison = await service.compareCheckpoints(target.id, "cp-1", "cp-1");
  assert.deepEqual(comparison.fields, []);
  await assert.rejects(
    () => service.compareCheckpoints(target.id, "missing", "cp-1"),
    /检查点不存在/u,
  );

  const restored = await service.restoreCheckpoint(target.id, "cp-1");
  assert.deepEqual(restored, checkpoint);
  const allEvents = await service.readEvents(target.id, 0);
  const restoreEvent = allEvents.find(
    (event) => event.type === HarnessEventType.CONTEXT_CHECKPOINT_RESTORED,
  );
  assert.ok(restoreEvent !== undefined, "恢复后应追加 context.checkpoint_restored");
  assert.deepEqual(restoreEvent.data, { checkpoint, checkpointId: "cp-1" });
});
