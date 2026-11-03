import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionController, WorkflowNodeSpec } from "../src/services/session-types";
import {
  matchesTriggerCondition,
  WorkflowService,
  WorkflowServiceError,
} from "../src/services/workflow-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let service: WorkflowService;
let startCalls: { nodes: readonly WorkflowNodeSpec[]; sessionId: string }[] = [];
let failStart = false;
let sessionRunning = false;
const eventsBySession = new Map<string, import("@harness/core").HarnessEvent[]>();

const nodes: WorkflowNodeSpec[] = [
  { agentType: "explorer", id: "research", task: "调研工作区", title: "调研" },
  { dependsOn: ["research"], id: "implement", task: "实现改进", title: "实现" },
];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-workflow-service-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
  const sessions = {
    archiveSession: (id: string) => database.archiveSession(id),
    getSnapshot: async () => ({ isRunning: sessionRunning }) as never,
    readEvents: async (sessionId: string) => eventsBySession.get(sessionId) ?? [],
    createSession: async (input: { title?: string; workspaceRoot?: string }) =>
      database.createSession({
        title: input.title ?? "工作流",
        workspaceRoot: input.workspaceRoot ?? join(root, "workspace"),
      }),
    startWorkflow: async (sessionId: string, workflowNodes: readonly WorkflowNodeSpec[]) => {
      if (failStart) throw new Error("start failed");
      startCalls.push({ nodes: workflowNodes, sessionId });
      return { runId: "run-1" };
    },
  } as unknown as SessionController;
  service = new WorkflowService({ database, sessions });
});

after(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("工作流 CRUD、标题与 DAG 校验", () => {
  const created = service.create({ nodes, title: "  发布流程  " });
  assert.equal(created.title, "发布流程");
  assert.equal(created.nodes.length, 2);
  assert.equal(service.list().length, 1);

  const updated = service.update(created.id, { title: "新流程" });
  assert.equal(updated.title, "新流程");

  assert.throws(
    () => service.create({ nodes: [], title: "空" }),
    (error: unknown) => error instanceof WorkflowServiceError && error.code === "INVALID",
  );
  assert.throws(
    () =>
      service.create({
        nodes: [{ dependsOn: ["missing"], id: "a", task: "任务" }],
        title: "坏依赖",
      }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  assert.throws(
    () =>
      service.create({
        nodes: [
          { dependsOn: ["b"], id: "a", task: "A" },
          { dependsOn: ["a"], id: "b", task: "B" },
        ],
        title: "环",
      }),
    (error: unknown) => error instanceof WorkflowServiceError && error.message.includes("环"),
  );

  service.delete(created.id);
  assert.throws(
    () => service.get(created.id),
    (error: unknown) => error instanceof WorkflowServiceError && error.code === "NOT_FOUND",
  );
});

test("从已保存工作流运行会创建 Session 并记录最近运行", async () => {
  startCalls = [];
  const created = service.create({ nodes, title: "运行流程" });
  const result = await service.run(created.id);
  assert.equal(result.runId, "run-1");
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0]?.sessionId, result.session.id);
  assert.deepEqual(
    startCalls[0]?.nodes.map((node) => ({
      dependsOn: node.dependsOn,
      id: node.id,
      task: node.task,
    })),
    [
      { dependsOn: [], id: "research", task: "调研工作区" },
      { dependsOn: ["research"], id: "implement", task: "实现改进" },
    ],
  );

  const reloaded = service.get(created.id);
  assert.equal(reloaded.lastRunSessionId, result.session.id);
  assert.notEqual(reloaded.lastRunAt, null);
  service.delete(created.id);
});

test("启动失败时归档临时 Session", async () => {
  const created = service.create({ nodes, title: "失败流程" });
  failStart = true;
  try {
    await assert.rejects(service.run(created.id));
    assert.equal(service.get(created.id).lastRunSessionId, null);
    const sessions = database.listSessions();
    assert.ok(sessions.every((session) => session.title !== "工作流 · 失败流程"));
  } finally {
    failStart = false;
    service.delete(created.id);
  }
});

test("调度字段、due 列表与运行重叠保护", async () => {
  const now = Date.now();
  const created = service.create({
    nodes,
    scheduleIntervalMinutes: 15,
    title: "定时流程",
  });
  assert.equal(created.scheduleIntervalMinutes, 15);
  assert.notEqual(created.nextRunAt, null);
  assert.equal(
    service.listDue(now).some((item) => item.id === created.id),
    false,
  );
  assert.equal(
    service.listDue(now + 16 * 60_000).some((item) => item.id === created.id),
    true,
  );

  const first = await service.runScheduled(created.id, now + 16 * 60_000);
  assert.notEqual(first, null);
  sessionRunning = true;
  const result = await service.runScheduled(created.id, now + 32 * 60_000);
  assert.equal(result, null);
  sessionRunning = false;

  const disabled = service.update(created.id, { scheduleIntervalMinutes: null });
  assert.equal(disabled.scheduleIntervalMinutes, null);
  assert.equal(disabled.nextRunAt, null);
  assert.throws(
    () => service.update(created.id, { scheduleIntervalMinutes: 0 }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  service.delete(created.id);
});

test("运行历史从事件派生完成状态", async () => {
  const created = service.create({ nodes, title: "历史流程" });
  const result = await service.run(created.id);
  eventsBySession.set(result.session.id, [
    {
      data: { steps: 2 },
      id: "e1",
      runId: result.runId,
      seq: 1,
      sessionId: result.session.id,
      timestamp: Date.now(),
      type: "run.completed",
    } as never,
  ]);
  const history = await service.history(created.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.status, "completed");
  assert.equal(history[0]?.runId, result.runId);
  assert.notEqual(history[0]?.endedAt, null);
  service.delete(created.id);
});

test("Webhook token 与文件监听配置", async () => {
  const created = service.create({
    fileWatchEnabled: true,
    fileWatchPaths: ["src", "notes.md"],
    nodes,
    title: "触发流程",
    webhookEnabled: true,
  });
  assert.notEqual(created.webhookToken, null);
  assert.equal(created.fileWatchEnabled, true);
  assert.deepEqual(created.fileWatchPaths, ["src", "notes.md"]);
  assert.equal(service.verifyWebhook(created.id, created.webhookToken ?? "").id, created.id);
  assert.throws(
    () => service.verifyWebhook(created.id, "wrong"),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  assert.equal(
    service.listFileWatchWorkflows().some((item) => item.id === created.id),
    true,
  );

  const disabled = service.update(created.id, { webhookEnabled: false });
  assert.equal(disabled.webhookToken, null);
  assert.throws(
    () => service.update(created.id, { fileWatchPaths: ["../outside"] }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  assert.throws(
    () => service.update(created.id, { fileWatchPaths: ["/absolute"] }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  service.delete(created.id);
});

test("cron、时区与触发条件", () => {
  const scheduled = service.create({
    nodes,
    scheduleCron: "0 9 * * *",
    scheduleTimezone: "Asia/Shanghai",
    title: "cron 流程",
    triggerCondition: { type: "fileMatches", value: "**/*.md" },
  });
  assert.notEqual(scheduled.nextRunAt, null);
  assert.equal(scheduled.scheduleCron, "0 9 * * *");
  assert.equal(scheduled.scheduleTimezone, "Asia/Shanghai");
  assert.deepEqual(scheduled.triggerCondition, { type: "fileMatches", value: "**/*.md" });
  assert.equal(
    matchesTriggerCondition(scheduled.triggerCondition, {
      kind: "file",
      value: "docs/readme.md",
    }),
    true,
  );
  assert.equal(
    matchesTriggerCondition(scheduled.triggerCondition, {
      kind: "file",
      value: "docs/readme.txt",
    }),
    false,
  );
  assert.equal(
    matchesTriggerCondition(
      { type: "webhookContains", value: "deploy" },
      {
        kind: "webhook",
        value: '{"event":"deploy"}',
      },
    ),
    true,
  );
  assert.equal(matchesTriggerCondition({ type: "always" }, { kind: "file", value: "x" }), true);

  assert.throws(
    () => service.create({ nodes, scheduleCron: "bad cron", title: "坏 cron" }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  assert.throws(
    () =>
      service.create({
        nodes,
        scheduleCron: "0 9 * * *",
        scheduleTimezone: "Mars/Olympus",
        title: "坏时区",
      }),
    (error: unknown) => error instanceof WorkflowServiceError,
  );
  service.delete(scheduled.id);
});
