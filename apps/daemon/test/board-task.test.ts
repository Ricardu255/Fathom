import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  BoardTaskStatus,
  type HarnessEvent,
  HarnessEventType,
  type SessionId,
  type TodoItem,
} from "@harness/core";
import { type HarnessConfig, loadConfig } from "../src/config";
import { BoardTaskService, BoardTaskServiceError } from "../src/services/board-task-service";
import type { SessionController, SessionSnapshot } from "../src/services/session-types";
import { HarnessDatabase } from "../src/storage/database";
import { SessionEventStore } from "../src/storage/event-store";

interface TestContext {
  board: BoardTaskService;
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  seqs: Map<string, number>;
  tempRoot: string;
}

let ctx: TestContext | undefined;

function context(): TestContext {
  if (ctx === undefined) throw new Error("测试上下文尚未初始化");
  return ctx;
}

function makeFakeSessions(database: HarnessDatabase, config: HarnessConfig): SessionController {
  let runCounter = 0;
  return {
    abort: () => true,
    archiveSession: () => undefined,
    close: () => undefined,
    compact: async () => undefined,
    createSession: async (input) =>
      database.createSession({
        title: input.title ?? "未命名任务",
        workspaceRoot: input.workspaceRoot ?? config.workspaceRoot,
      }),
    getSession: (sessionId) => {
      const session = database.getSession(sessionId);
      if (session === null) throw new Error("Session 不存在");
      return session;
    },
    forkSession: async (_sessionId: string, _fromTimestamp?: number) =>
      database.createSession({ title: "fork", workspaceRoot: config.workspaceRoot }),
    getDisabledSkills: () => [],
    setSkillEnabled: () => [],
    getSettings: () => ({
      approvalMode: "auto_approve",
      sandbox: { allowedDomains: [], deniedDomains: [], profile: "off" },
    }),
    isSessionRunning: () => false,
    compareSessions: async () => {
      throw new Error("not implemented");
    },
    mergeCode: async () => {
      throw new Error("not implemented");
    },
    previewCodeMerge: async () => [],
    getSnapshot: async () => ({ isRunning: false }) as unknown as SessionSnapshot,
    initialize: async () => undefined,
    listAllowedCommandPrefixes: () => [],
    listCheckpoints: async () => [],
    listQueued: () => [],
    compareCheckpoints: async () => {
      throw new Error("not implemented");
    },
    restoreCheckpoint: async () => {
      throw new Error("not implemented");
    },
    rewriteSession: async () => {
      throw new Error("not implemented");
    },
    listSessions: () => database.listSessions(),
    readEvents: async () => [],
    removeAllowedCommandPrefix: () => [],
    removeQueued: async () => false,
    renameSession: () => undefined,
    mergeSessions: async () => {
      throw new Error("not implemented");
    },
    resumeSession: async () => {
      throw new Error("not implemented");
    },
    restoreSession: () => undefined,
    resolveApproval: () => true,
    resolveUserInput: async () => true,
    setApprovalMode: () => ({
      approvalMode: "auto_approve",
      sandbox: { allowedDomains: [], deniedDomains: [], profile: "off" },
    }),
    setSandboxSettings: () => ({
      approvalMode: "auto_approve",
      sandbox: { allowedDomains: [], deniedDomains: [], profile: "off" },
    }),
    updateSessionModel: async (
      sessionId: string,
      providerId: string,
      modelId: string,
      thinkingLevel: string,
    ) => {
      const session = database.updateSessionModel(sessionId, providerId, modelId, thinkingLevel);
      if (session === null) throw new Error("Session 不存在");
      return session;
    },
    startRun: async (
      _sessionId: string,
      _text: string,
      _images?: readonly unknown[],
      _planMode?: boolean,
      _attachments?: readonly string[],
    ) => {
      runCounter += 1;
      return { runId: `run-${runCounter}` };
    },
    steerRun: async () => "queued",
    startWorkflow: async () => ({ runId: "workflow-run" }),
  };
}

async function appendEvent(
  sessionId: SessionId,
  type: HarnessEvent["type"],
  data: unknown,
  runId: string,
): Promise<void> {
  const current = context();
  const seq = (current.seqs.get(sessionId) ?? 0) + 1;
  current.seqs.set(sessionId, seq);
  await current.events.append({
    data,
    id: randomUUID(),
    runId,
    seq,
    sessionId,
    timestamp: Date.now(),
    type,
  });
}

function isBoardError(code: BoardTaskServiceError["code"]) {
  return (error: unknown): boolean => error instanceof BoardTaskServiceError && error.code === code;
}

before(async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "harness-board-"));
  const config = loadConfig({
    HARNESS_DATA_DIR: join(tempRoot, "data"),
    HARNESS_ENGINE: "pi",
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: join(tempRoot, "workspace"),
  });
  await mkdir(config.workspaceRoot, { recursive: true });
  const database = new HarnessDatabase(join(config.dataDir, "harness.sqlite"));
  const events = new SessionEventStore({ directory: config.sessionsDir });
  await events.initialize();
  const board = new BoardTaskService({
    config,
    database,
    events,
    sessions: makeFakeSessions(database, config),
  });
  ctx = { board, config, database, events, seqs: new Map(), tempRoot };
});

after(async () => {
  const current = ctx;
  ctx = undefined;
  if (current === undefined) return;
  current.database.close();
  await rm(current.tempRoot, { recursive: true, force: true });
});

test("创建任务：默认进入待开始并规范化文本", async () => {
  const { board, config } = context();
  const task = await board.create({
    objective: "  完成登录页的会话恢复，并补充测试。  ",
    title: "  会话恢复  ",
  });

  assert.equal(task.status, BoardTaskStatus.PENDING);
  assert.equal(task.title, "会话恢复");
  assert.equal(task.objective, "完成登录页的会话恢复，并补充测试。");
  assert.equal(task.workspaceRoot, config.workspaceRoot);
  assert.equal(task.sessionId, null);
  assert.equal(task.rootRunId, null);
  assert.equal(task.completedAt, null);
  assert.equal(
    (await board.list()).some((item) => item.id === task.id),
    true,
  );

  await assert.rejects(
    board.create({ objective: "   ", title: "有效标题" }),
    isBoardError("INVALID"),
  );
  await assert.rejects(
    board.create({ objective: "有效目标", title: "   " }),
    isBoardError("INVALID"),
  );
  await assert.rejects(
    board.create({
      objective: "有效目标",
      title: "有效标题",
      workspaceRoot: join(config.dataDir, "missing-workspace"),
    }),
    isBoardError("INVALID"),
  );
});

test("编辑与删除：校验状态和输入", async () => {
  const { board } = context();
  const task = await board.create({ objective: "初始目标", title: "初始标题" });

  const updated = await board.update(task.id, { title: "  新标题  " });
  assert.equal(updated.title, "新标题");
  assert.equal(updated.objective, "初始目标");
  await assert.rejects(board.update(task.id, { objective: "  " }), isBoardError("INVALID"));

  await board.remove(task.id);
  await assert.rejects(board.get(task.id), isBoardError("NOT_FOUND"));
  await assert.rejects(board.update(task.id, { title: "x" }), isBoardError("NOT_FOUND"));
  await assert.rejects(board.remove(task.id), isBoardError("NOT_FOUND"));
});

test("工作区列表包含默认目录与已有 Session 目录并去重", async () => {
  const { board, config, database, tempRoot } = context();
  const otherRoot = join(tempRoot, "other-workspace");
  await mkdir(otherRoot, { recursive: true });
  database.createSession({ title: "其他工作区", workspaceRoot: otherRoot });
  database.createSession({ title: "同工作区", workspaceRoot: otherRoot });

  const workspaces = await board.workspaces();
  const roots = workspaces.map((workspace) => workspace.root);
  assert.equal(roots.filter((root) => root === otherRoot).length, 1);
  assert.equal(roots.includes(config.workspaceRoot), true);
  assert.deepEqual(
    workspaces.map((workspace) => workspace.name),
    [...workspaces.map((workspace) => workspace.name)].sort((a, b) => a.localeCompare(b)),
  );
});

test("并发启动同一任务只允许一个 Run", async () => {
  const { board } = context();
  const task = await board.create({ objective: "并发启动测试", title: "并发启动" });

  const results = await Promise.allSettled([board.start(task.id), board.start(task.id)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(rejected !== undefined);
  assert.ok(isBoardError("BUSY")(rejected.reason));
});

test("启动任务后从事件派生进度、审批、待确认并确认完成", { timeout: 20_000 }, async () => {
  const { board } = context();
  const task = await board.create({ objective: "实现并验证会话恢复", title: "会话恢复实现" });

  const started = await board.start(task.id);
  assert.equal(typeof started.runId, "string");
  assert.equal(started.task.status, BoardTaskStatus.IN_PROGRESS);
  assert.equal(started.task.sessionId, started.sessionId);
  assert.equal(started.task.rootRunId, started.runId);
  await assert.rejects(board.start(task.id), isBoardError("BUSY"));
  await assert.rejects(board.update(task.id, { title: "运行中改名" }), isBoardError("BUSY"));
  await assert.rejects(board.remove(task.id), isBoardError("BUSY"));

  const { sessionId } = started;
  const { runId } = started;
  await appendEvent(sessionId, HarnessEventType.RUN_STARTED, { model: "mock", tools: [] }, runId);
  await appendEvent(
    sessionId,
    HarnessEventType.TODOS_UPDATED,
    {
      todos: [
        { content: "读取现有实现", id: "1", status: "completed" },
        { content: "编写恢复逻辑", id: "2", status: "in_progress" },
        { content: "补充测试", id: "3", status: "pending" },
      ] satisfies TodoItem[],
    },
    runId,
  );
  await appendEvent(
    sessionId,
    HarnessEventType.FILE_CHANGED,
    { changeType: "modified", path: "src/session.ts" },
    runId,
  );
  await appendEvent(
    sessionId,
    HarnessEventType.FILE_CHANGED,
    { changeType: "modified", path: "src/session.ts" },
    runId,
  );
  await appendEvent(
    sessionId,
    HarnessEventType.FILE_CHANGED,
    { changeType: "added", path: "src/session.test.ts" },
    runId,
  );

  let view = await board.get(task.id);
  assert.equal(view.status, BoardTaskStatus.IN_PROGRESS);
  assert.deepEqual(view.progress, { completed: 1, total: 3 });
  assert.equal(view.currentStep, "编写恢复逻辑");
  assert.equal(view.fileChangeCount, 2);
  assert.equal(view.attentionReason, null);

  await appendEvent(
    sessionId,
    HarnessEventType.APPROVAL_REQUESTED,
    { approvalId: "approval-1", summary: "写入 src/session.ts" },
    runId,
  );
  view = await board.get(task.id);
  assert.equal(view.status, BoardTaskStatus.WAITING);
  assert.equal(view.attentionReason, "写入 src/session.ts");

  await appendEvent(
    sessionId,
    HarnessEventType.APPROVAL_RESOLVED,
    { approvalId: "approval-1", approved: true },
    runId,
  );
  await appendEvent(sessionId, HarnessEventType.RUN_COMPLETED, {}, runId);
  view = await board.get(task.id);
  assert.equal(view.status, BoardTaskStatus.CONFIRMATION);
  assert.equal(view.attentionReason, null);

  const completed = await board.confirm(task.id);
  assert.equal(completed.status, BoardTaskStatus.COMPLETED);
  assert.equal(typeof completed.completedAt, "number");
  assert.equal((await board.confirm(task.id)).status, BoardTaskStatus.COMPLETED);
  await assert.rejects(board.update(task.id, { title: "已完成后改名" }), isBoardError("CONFLICT"));
  await assert.rejects(board.start(task.id), isBoardError("CONFLICT"));

  await board.remove(task.id);
  await assert.rejects(board.get(task.id), isBoardError("NOT_FOUND"));
});

test("失败的 Run 进入需处理，可编辑并重新启动", { timeout: 20_000 }, async () => {
  const { board } = context();
  const task = await board.create({ objective: "执行可能失败的任务", title: "失败重试" });
  const first = await board.start(task.id);

  await appendEvent(
    first.sessionId,
    HarnessEventType.RUN_STARTED,
    { model: "mock", tools: [] },
    first.runId,
  );
  await appendEvent(
    first.sessionId,
    HarnessEventType.RUN_FAILED,
    { message: "模型调用失败" },
    first.runId,
  );

  const view = await board.get(task.id);
  assert.equal(view.status, BoardTaskStatus.WAITING);
  assert.equal(view.attentionReason, "模型调用失败");

  const edited = await board.update(task.id, { objective: "调整后的目标" });
  assert.equal(edited.objective, "调整后的目标");

  const second = await board.start(task.id);
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.task.status, BoardTaskStatus.IN_PROGRESS);
  assert.equal(second.task.rootRunId, second.runId);

  const running = await board.get(task.id);
  assert.equal(running.status, BoardTaskStatus.IN_PROGRESS);
});
