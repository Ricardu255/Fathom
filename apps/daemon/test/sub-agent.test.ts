import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AgentMessage,
  type HarnessEvent,
  HarnessEventType,
  messageText,
  type SubAgentTerminalData,
  type SubAgentView,
  type Tool,
  type ToolContext,
  type Usage,
} from "@harness/core";
import { type HarnessConfig, loadConfig } from "../src/config";
import type { PiBridgeEmit } from "../src/pi/event-bridge";
import { createPiModelSetup, type PiModelSetup } from "../src/pi/model";
import {
  type SpawnSubAgentInput,
  SubAgentOrchestrator,
  type SubAgentResult,
} from "../src/pi/sub-agent-orchestrator";
import { createSubAgentTools } from "../src/pi/sub-agent-tools";
import { SessionEventBus } from "../src/services/event-bus";
import { PiSessionService } from "../src/services/pi-session-service";
import { projectEvents } from "../src/services/session-projections";
import { HarnessDatabase, type SessionRecord } from "../src/storage/database";
import { SessionEventStore } from "../src/storage/event-store";

const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 30_000;
const SESSION_ID = "session-sub-agent-test";

// ---------------------------------------------------------------------------
// 1. 事件投影
// ---------------------------------------------------------------------------

function makeEvent(type: HarnessEvent["type"], data: unknown, seq: number): HarnessEvent {
  return {
    data,
    id: `event-${seq}-${randomUUID()}`,
    runId: "run-projection",
    seq,
    sessionId: SESSION_ID,
    timestamp: 1_700_000_000_000 + seq,
    type,
  };
}

function subAgentStart(executionId: string, seq: number): HarnessEvent {
  return makeEvent(
    HarnessEventType.SUBAGENT_STARTED,
    {
      agentType: "explorer",
      executionId,
      modelId: "claude-sonnet-5-5",
      name: "researcher",
      parentExecutionId: null,
      task: "调研当前工作区结构并总结关键文件。",
    },
    seq,
  );
}

function assistantMessage(text: string): AgentMessage {
  return { content: [{ text, type: "text" }], role: "assistant", timestamp: 1_700_000_000_100 };
}

function terminalEvent(
  type: HarnessEvent["type"],
  executionId: string,
  seq: number,
  data: Partial<SubAgentTerminalData>,
): HarnessEvent {
  return makeEvent(
    type,
    { executionId, parentExecutionId: null, ...data } satisfies SubAgentTerminalData,
    seq,
  );
}

test("projectEvents 聚合 subagent 事件为单个已完成视图", () => {
  const toolInput = { depth: 3, path: "." };
  const message = assistantMessage("工作区里只有 README.md。");
  const events: HarnessEvent[] = [
    subAgentStart("exec-projection", 1),
    makeEvent(
      HarnessEventType.SUBAGENT_MESSAGE_COMPLETED,
      { executionId: "exec-projection", message, parentExecutionId: null },
      2,
    ),
    makeEvent(
      HarnessEventType.SUBAGENT_TOOL_STARTED,
      {
        executionId: "exec-projection",
        input: toolInput,
        toolCallId: "call-list",
        toolName: "list_files",
      },
      3,
    ),
    makeEvent(
      HarnessEventType.SUBAGENT_TOOL_COMPLETED,
      {
        executionId: "exec-projection",
        result: "README.md",
        toolCallId: "call-list",
        toolName: "list_files",
      },
      4,
    ),
    terminalEvent(HarnessEventType.SUBAGENT_COMPLETED, "exec-projection", 5, {
      resultSummary: "工作区里只有 README.md。",
      usage: { inputTokens: 12, outputTokens: 34 },
    }),
  ];

  const projections = projectEvents(events);

  assert.equal(projections.subAgents.length, 1);
  const agent = projections.subAgents[0];
  assert.ok(agent !== undefined);
  assert.equal(agent.executionId, "exec-projection");
  assert.equal(agent.name, "researcher");
  assert.equal(agent.agentType, "explorer");
  assert.equal(agent.status, "completed");
  assert.equal(agent.errorCode, null);
  assert.equal(agent.task, "调研当前工作区结构并总结关键文件。");

  assert.equal(agent.messages.length, 1);
  assert.deepEqual(agent.messages[0], message);

  assert.equal(agent.tools.length, 1);
  const tool = agent.tools[0];
  assert.ok(tool !== undefined);
  assert.equal(tool.toolCallId, "call-list");
  assert.equal(tool.toolName, "list_files");
  assert.deepEqual(tool.input, toolInput);
  assert.equal(tool.status, "completed");
  assert.equal(tool.result, "README.md");
  assert.equal(tool.error, undefined);

  assert.equal(agent.resultSummary, "工作区里只有 README.md。");
});

test("projectEvents 应把终态 usage 写入 SubAgentView.usage", () => {
  const events: HarnessEvent[] = [
    subAgentStart("exec-usage", 1),
    terminalEvent(HarnessEventType.SUBAGENT_COMPLETED, "exec-usage", 2, {
      resultSummary: "done",
      usage: { inputTokens: 7, outputTokens: 9 },
    }),
  ];
  const agent = projectEvents(events).subAgents[0];
  assert.ok(agent !== undefined);
  assert.deepEqual(agent.usage, { inputTokens: 7, outputTokens: 9 } satisfies Usage);
});

test("projectEvents 将 failed/aborted 终态映射为对应状态与错误码", () => {
  const events: HarnessEvent[] = [
    subAgentStart("exec-failed", 1),
    terminalEvent(HarnessEventType.SUBAGENT_FAILED, "exec-failed", 2, {
      errorCode: "SUBAGENT_TIMEOUT",
    }),
    subAgentStart("exec-aborted", 3),
    terminalEvent(HarnessEventType.SUBAGENT_ABORTED, "exec-aborted", 4, {
      resultSummary: "部分结果",
    }),
  ];

  const byId = new Map<string, SubAgentView>(
    projectEvents(events).subAgents.map((agent) => [agent.executionId, agent]),
  );
  assert.equal(byId.size, 2);

  const failed = byId.get("exec-failed");
  assert.ok(failed !== undefined);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "SUBAGENT_TIMEOUT");

  const aborted = byId.get("exec-aborted");
  assert.ok(aborted !== undefined);
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.errorCode, null);
  assert.equal(aborted.resultSummary, "部分结果");
});

test("projectEvents 忽略缺少 executionId 的 subagent 事件", () => {
  const projections = projectEvents([
    makeEvent(HarnessEventType.SUBAGENT_STARTED, { name: "orphan" }, 1),
    makeEvent(HarnessEventType.SUBAGENT_COMPLETED, { resultSummary: "orphan" }, 2),
  ]);
  assert.equal(projections.subAgents.length, 0);
});

test("projectEvents 保留未决审批并移除已解决审批", () => {
  const events: HarnessEvent[] = [
    makeEvent(
      HarnessEventType.APPROVAL_REQUESTED,
      {
        approvalId: "approval-1",
        input: { path: "a.ts" },
        summary: "写入 a.ts",
        toolCallId: "tool-1",
        toolName: "write_file",
      },
      1,
    ),
    makeEvent(
      HarnessEventType.APPROVAL_REQUESTED,
      {
        approvalId: "approval-2",
        executionId: "exec-1",
        input: { command: "npm test" },
        summary: "执行测试",
        toolCallId: "tool-2",
        toolName: "run_command",
      },
      2,
    ),
    makeEvent(
      HarnessEventType.APPROVAL_RESOLVED,
      { approvalId: "approval-1", decision: "approved" },
      3,
    ),
  ];

  assert.deepEqual(
    projectEvents(events).approvals.map((approval) => approval.approvalId),
    ["approval-2"],
  );
});

// ---------------------------------------------------------------------------
// 2. 工具层（fake orchestrator）
// ---------------------------------------------------------------------------

interface WaitCall {
  executionIds: readonly string[];
  mode: "all" | "any";
  signal: AbortSignal;
  timeoutSeconds: number;
}

function createFakeOrchestrator() {
  const calls = {
    send: [] as { executionId: string; message: string }[],
    spawn: [] as SpawnSubAgentInput[],
    stop: [] as string[],
    wait: [] as WaitCall[],
  };
  let sendDisposition: "queued" | "sent" = "queued";
  let stopResult = true;
  let waitResults: SubAgentResult[] = [];

  const orchestrator = {
    async send(executionId: string, message: string): Promise<"queued" | "sent"> {
      calls.send.push({ executionId, message });
      return sendDisposition;
    },
    async spawn(input: SpawnSubAgentInput): Promise<{ executionId: string; name: string }> {
      calls.spawn.push(input);
      return { executionId: "exec-fake-1", name: input.name ?? "worker-1" };
    },
    async stop(executionId: string): Promise<boolean> {
      calls.stop.push(executionId);
      return stopResult;
    },
    async wait(
      executionIds: readonly string[],
      mode: "all" | "any",
      timeoutSeconds: number,
      signal: AbortSignal,
    ): Promise<SubAgentResult[]> {
      calls.wait.push({ executionIds, mode, signal, timeoutSeconds });
      return waitResults;
    },
  } as unknown as SubAgentOrchestrator;

  return {
    calls,
    orchestrator,
    setSendDisposition(value: "queued" | "sent"): void {
      sendDisposition = value;
    },
    setStopResult(value: boolean): void {
      stopResult = value;
    },
    setWaitResults(value: SubAgentResult[]): void {
      waitResults = value;
    },
  };
}

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `缺少工具 ${name}`);
  return tool;
}

function toolContext(signal = new AbortController().signal): ToolContext {
  return { signal, workspaceRoot: join(tmpdir(), "harness-sub-agent-tools") };
}

test("createSubAgentTools 暴露四个工具且只读调用不需要审批", () => {
  const { orchestrator } = createFakeOrchestrator();
  const tools = createSubAgentTools(orchestrator);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "run_workflow",
    "send_agent",
    "spawn_agent",
    "stop_agent",
    "wait_agents",
  ]);
  for (const name of ["spawn_agent", "wait_agents", "send_agent", "stop_agent", "run_workflow"]) {
    const tool = findTool(tools, name);
    assert.equal(tool.requiresApproval, false);
    assert.equal(typeof tool.inputSchema, "object");
  }
});

test("spawn_agent 返回 executionId 并透传参数", async () => {
  const fake = createFakeOrchestrator();
  const tool = findTool(createSubAgentTools(fake.orchestrator), "spawn_agent");

  const result = await tool.execute(
    { agentType: "explorer", name: "researcher", task: "调研工作区" },
    toolContext(),
  );

  assert.match(result.content, /researcher/u);
  assert.match(result.content, /exec-fake-1/u);
  assert.deepEqual(fake.calls.spawn, [
    { agentType: "explorer", name: "researcher", task: "调研工作区" },
  ]);
});

test("wait_agents 格式化 results 并传递默认/显式参数", async () => {
  const fake = createFakeOrchestrator();
  const tool = findTool(createSubAgentTools(fake.orchestrator), "wait_agents");
  const signal = new AbortController().signal;

  fake.setWaitResults([
    {
      agentType: "explorer",
      executionId: "exec-completed",
      name: "researcher",
      resultSummary: "找到 3 个关键文件",
      status: "completed",
      usage: { inputTokens: 11, outputTokens: 22 },
    },
    {
      agentType: "worker",
      errorCode: "SUBAGENT_TIMEOUT",
      executionId: "exec-failed",
      name: "writer",
      status: "failed",
    },
  ]);

  const defaults = await tool.execute({}, toolContext(signal));
  assert.match(defaults.content, /researcher \[completed\] exec-completed/u);
  assert.match(defaults.content, /找到 3 个关键文件/u);
  assert.match(defaults.content, /tokens: 11 in \/ 22 out/u);
  assert.match(defaults.content, /writer \[failed\] exec-failed/u);
  assert.match(defaults.content, /错误：SUBAGENT_TIMEOUT/u);

  assert.equal(fake.calls.wait.length, 1);
  assert.deepEqual(fake.calls.wait[0]?.executionIds, []);
  assert.equal(fake.calls.wait[0]?.mode, "all");
  assert.equal(fake.calls.wait[0]?.timeoutSeconds, 300);
  assert.equal(fake.calls.wait[0]?.signal, signal);

  const explicit = await tool.execute(
    { executionIds: ["exec-completed", "exec-failed"], mode: "any", timeoutSeconds: 5 },
    toolContext(),
  );
  assert.equal(fake.calls.wait.length, 2);
  assert.deepEqual(fake.calls.wait[1]?.executionIds, ["exec-completed", "exec-failed"]);
  assert.equal(fake.calls.wait[1]?.mode, "any");
  assert.equal(fake.calls.wait[1]?.timeoutSeconds, 5);
  assert.match(explicit.content, /exec-completed/u);

  fake.setWaitResults([]);
  const empty = await tool.execute({ executionIds: ["missing"] }, toolContext());
  assert.equal(empty.content, "没有匹配的子 Agent。");
});

test("send_agent 返回 queued/sent 文案", async () => {
  const fake = createFakeOrchestrator();
  const tool = findTool(createSubAgentTools(fake.orchestrator), "send_agent");

  fake.setSendDisposition("queued");
  const queued = await tool.execute({ executionId: "exec-1", message: "继续调研" }, toolContext());
  assert.equal(queued.content, "消息已排队，子 Agent 会在当前回答后处理。");

  fake.setSendDisposition("sent");
  const sent = await tool.execute({ executionId: "exec-1", message: "补充一点" }, toolContext());
  assert.equal(sent.content, "消息已发送给子 Agent。");

  assert.deepEqual(fake.calls.send, [
    { executionId: "exec-1", message: "继续调研" },
    { executionId: "exec-1", message: "补充一点" },
  ]);
});

test("stop_agent 区分停止成功与已结束", async () => {
  const fake = createFakeOrchestrator();
  const tool = findTool(createSubAgentTools(fake.orchestrator), "stop_agent");

  fake.setStopResult(true);
  const stopped = await tool.execute({ executionId: "exec-1" }, toolContext());
  assert.equal(stopped.content, "子 Agent 已停止。");

  fake.setStopResult(false);
  const missing = await tool.execute({ executionId: "exec-2" }, toolContext());
  assert.equal(missing.content, "子 Agent 不存在或已经结束。");
  assert.deepEqual(fake.calls.stop, ["exec-1", "exec-2"]);
});

test("spawn/wait/send/stop 的非法参数被拒绝且不触达 orchestrator", async () => {
  const fake = createFakeOrchestrator();
  const tools = createSubAgentTools(fake.orchestrator);
  const spawn = findTool(tools, "spawn_agent");
  const wait = findTool(tools, "wait_agents");
  const send = findTool(tools, "send_agent");
  const stop = findTool(tools, "stop_agent");
  const context = toolContext();

  // spawn
  await assert.rejects(spawn.execute({ task: "" }, context));
  await assert.rejects(spawn.execute({ task: "x".repeat(20_001) }, context));
  await assert.rejects(spawn.execute({ agentType: "admin", task: "合法任务" }, context));
  await assert.rejects(spawn.execute({ name: "x".repeat(81), task: "合法任务" }, context));
  await assert.rejects(spawn.execute({ name: "", task: "合法任务" }, context));

  // wait
  await assert.rejects(wait.execute({ timeoutSeconds: 0 }, context));
  await assert.rejects(wait.execute({ timeoutSeconds: 901 }, context));
  await assert.rejects(wait.execute({ timeoutSeconds: 1.5 }, context));
  await assert.rejects(wait.execute({ mode: "some" }, context));
  await assert.rejects(
    wait.execute(
      { executionIds: Array.from({ length: 9 }, (_, index) => `exec-${index}`) },
      context,
    ),
  );
  await assert.rejects(wait.execute({ executionIds: [""] }, context));

  // send
  await assert.rejects(send.execute({ executionId: "exec-1", message: "" }, context));
  await assert.rejects(
    send.execute({ executionId: "exec-1", message: "x".repeat(10_001) }, context),
  );
  await assert.rejects(send.execute({ executionId: "", message: "hello" }, context));

  // stop
  await assert.rejects(stop.execute({}, context));
  await assert.rejects(stop.execute({ executionId: "" }, context));

  assert.deepEqual(fake.calls.spawn, []);
  assert.deepEqual(fake.calls.wait, []);
  assert.deepEqual(fake.calls.send, []);
  assert.deepEqual(fake.calls.stop, []);
});

// ---------------------------------------------------------------------------
// 3. 服务级集成（Mock 模型）
// ---------------------------------------------------------------------------

interface TestContext {
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  modelSetup: PiModelSetup;
  service: PiSessionService;
  session: SessionRecord;
  tempRoot: string;
}

let ctx: TestContext | undefined;

function context(): TestContext {
  if (ctx === undefined) throw new Error("测试上下文尚未初始化");
  return ctx;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时（${POLL_TIMEOUT_MS}ms）: ${label}`);
    await delay(POLL_INTERVAL_MS);
  }
}

before(async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "harness-sub-agent-"));
  const config = loadConfig({
    HARNESS_DATA_DIR: join(tempRoot, "data"),
    HARNESS_ENGINE: "pi",
    HARNESS_MOCK_MODEL: "1",
    HARNESS_MODEL: "claude-sonnet-5-5",
    HARNESS_WORKSPACE: join(tempRoot, "workspace"),
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
      error: (details, message) => console.error(`[sub-agent-test] ${message}`, details),
      warn: (details, message) => console.warn(`[sub-agent-test] ${message}`, details),
    },
    modelSetup,
  });
  await service.initialize();
  const session = await service.createSession({ title: "sub-agent-test" });
  ctx = { config, database, events, modelSetup, service, session, tempRoot };
});

after(async () => {
  const current = ctx;
  ctx = undefined;
  if (current === undefined) return;
  await current.service.close();
  current.database.close();
  await rm(current.tempRoot, { recursive: true, force: true });
});

test("Mock 服务级：spawn 子 Agent 调研并投影到 snapshot", { timeout: 60_000 }, async () => {
  const { service, session } = context();
  const beforeSeq = 0;

  const started = await service.startRun(session.id, "拆分任务给子代理，调研工作区");
  assert.equal(typeof started.runId, "string");
  assert.equal(started.queuedInputId, undefined);

  const result = await waitFor("父 Run 结束且子 Agent 到达终态", async () => {
    const snapshot = await service.getSnapshot(session.id);
    if (snapshot.isRunning) return undefined;
    const events = await service.readEvents(session.id, beforeSeq);
    const runTerminal = events.find(
      (event) =>
        event.type === HarnessEventType.RUN_COMPLETED ||
        event.type === HarnessEventType.RUN_FAILED ||
        event.type === HarnessEventType.RUN_ABORTED,
    );
    const subAgentTerminal = events.find(
      (event) =>
        event.type === HarnessEventType.SUBAGENT_COMPLETED ||
        event.type === HarnessEventType.SUBAGENT_FAILED ||
        event.type === HarnessEventType.SUBAGENT_ABORTED,
    );
    return runTerminal === undefined || subAgentTerminal === undefined
      ? undefined
      : { events, runTerminal, snapshot, subAgentTerminal };
  });

  assert.equal(result.runTerminal.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(result.runTerminal.runId, started.runId);

  const types = result.events.map((event) => event.type);
  for (const required of [
    HarnessEventType.SUBAGENT_STARTED,
    HarnessEventType.SUBAGENT_TOOL_STARTED,
    HarnessEventType.SUBAGENT_COMPLETED,
  ]) {
    assert.ok(types.includes(required), `事件流缺少 ${required}: ${types.join(", ")}`);
  }

  assert.equal(result.snapshot.subAgents.length, 1);
  const agent = result.snapshot.subAgents[0];
  assert.ok(agent !== undefined);
  assert.equal(agent.name, "researcher");
  assert.equal(agent.agentType, "explorer");
  assert.equal(agent.status, "completed");
  assert.equal(agent.errorCode, null);
  assert.equal(typeof agent.resultSummary, "string");
  assert.ok((agent.resultSummary ?? "").trim() !== "", "子 Agent 应有结果摘要");

  const listFiles = agent.tools.find((tool) => tool.toolName === "list_files");
  assert.ok(
    listFiles !== undefined,
    `子 Agent 应调用 list_files，实际：${JSON.stringify(agent.tools)}`,
  );
  assert.equal(listFiles.status, "completed");

  const parentAssistantTexts = result.snapshot.messages
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message));
  assert.ok(
    parentAssistantTexts.some(
      (text) => text.includes("工具执行完成") && text.includes("researcher"),
    ),
    `父 Session 应包含最终 assistant 文本，实际：${JSON.stringify(parentAssistantTexts)}`,
  );
});

// ---------------------------------------------------------------------------
// 4. spawn 后 stop 进入 aborted 且不挂起
// ---------------------------------------------------------------------------

test("orchestrator.spawn 后 stop 会进入 aborted 且完成 promise 不挂起", {
  timeout: 60_000,
}, async () => {
  const { config, database, modelSetup } = context();
  await mkdir(config.workspaceRoot, { recursive: true });

  const emitted: HarnessEvent[] = [];
  const emit: PiBridgeEmit = async (draft) => {
    const event: HarnessEvent = {
      data: draft.data,
      id: randomUUID(),
      runId: draft.runId,
      seq: emitted.length + 1,
      sessionId: "orchestrator-stop-test",
      timestamp: Date.now(),
      type: draft.type,
    };
    emitted.push(event);
    return event;
  };

  const orchestrator = new SubAgentOrchestrator({
    config,
    database,
    emit,
    getRunId: () => "run-stop-test",
    logger: {
      error: (details, message) => console.error(`[sub-agent-test] ${message}`, details),
      warn: (details, message) => console.warn(`[sub-agent-test] ${message}`, details),
    },
    modelSetup,
    protectedPaths: [config.dataDir],
    requestApproval: async () => true,
    searchKnowledge: async () => [],
    workspaceRoot: config.workspaceRoot,
  });

  try {
    const spawned = await orchestrator.spawn({
      agentType: "explorer",
      name: "researcher",
      task: "调研当前工作区结构并总结关键文件。",
    });
    const stopped = await orchestrator.stop(spawned.executionId);
    assert.equal(stopped, true);

    const agents = orchestrator.list();
    const agent = agents.find((candidate) => candidate.executionId === spawned.executionId);
    assert.ok(agent !== undefined);
    assert.equal(agent.status, "aborted");
    assert.ok(
      emitted.some(
        (event) =>
          event.type === HarnessEventType.SUBAGENT_ABORTED &&
          (event.data as { executionId?: unknown }).executionId === spawned.executionId,
      ),
      "应写入 subagent.aborted 事件",
    );
    assert.equal(await orchestrator.stop(spawned.executionId), false, "重复 stop 应返回 false");
    assert.equal(orchestrator.activeCount, 0);
  } finally {
    await orchestrator.dispose();
  }
});

test("Mock 服务级：run_workflow 按依赖调度并投影 DAG", { timeout: 90_000 }, async () => {
  const { service } = context();
  const session = await service.createSession({ title: "workflow-dag-test" });

  const started = await service.startRun(session.id, "运行一个工作流");
  assert.equal(typeof started.runId, "string");

  const result = await waitFor("工作流完成", async () => {
    const snapshot = await service.getSnapshot(session.id);
    if (snapshot.isRunning) return undefined;
    const events = await service.readEvents(session.id, 0);
    const runTerminal = events.find(
      (event) =>
        event.type === HarnessEventType.RUN_COMPLETED ||
        event.type === HarnessEventType.RUN_FAILED ||
        event.type === HarnessEventType.RUN_ABORTED,
    );
    const terminals = events.filter(
      (event) =>
        event.type === HarnessEventType.SUBAGENT_COMPLETED ||
        event.type === HarnessEventType.SUBAGENT_FAILED ||
        event.type === HarnessEventType.SUBAGENT_ABORTED,
    );
    return runTerminal !== undefined && terminals.length >= 4
      ? { events, runTerminal, snapshot, terminals }
      : undefined;
  });

  assert.equal(result.runTerminal.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(result.snapshot.subAgents.length, 4);

  const byName = new Map(result.snapshot.subAgents.map((agent) => [agent.name, agent]));
  const requireAgent = (name: string) => {
    const agent = byName.get(name);
    assert.ok(agent !== undefined, `缺少子 Agent ${name}`);
    return agent;
  };
  const research = requireAgent("调研工作区");
  const implement = requireAgent("实现改进");
  const docs = requireAgent("整理文档");
  const review = requireAgent("审查结果");
  for (const agent of [research, implement, docs, review]) {
    assert.equal(agent.status, "completed");
  }
  assert.deepEqual(research.dependsOn, []);
  assert.equal(implement.dependsOn.length, 1);
  assert.equal(docs.dependsOn.length, 1);
  assert.equal(review.dependsOn.length, 2);
  assert.deepEqual(
    new Set([...implement.dependsOn, ...docs.dependsOn]),
    new Set([research.executionId]),
  );
  assert.deepEqual(new Set(review.dependsOn), new Set([implement.executionId, docs.executionId]));

  const startedEvents = result.events.filter(
    (event) => event.type === HarnessEventType.SUBAGENT_STARTED,
  );
  const startSeq = new Map(
    startedEvents.map((event) => [(event.data as { name: string }).name, event.seq]),
  );
  assert.ok((startSeq.get("调研工作区") ?? 0) < (startSeq.get("实现改进") ?? 0));
  assert.ok((startSeq.get("调研工作区") ?? 0) < (startSeq.get("整理文档") ?? 0));
  assert.ok((startSeq.get("实现改进") ?? 0) < (startSeq.get("审查结果") ?? 0));
  assert.ok((startSeq.get("整理文档") ?? 0) < (startSeq.get("审查结果") ?? 0));
  assert.ok(result.events.some((event) => event.type === HarnessEventType.SUBAGENT_QUEUED));
});
