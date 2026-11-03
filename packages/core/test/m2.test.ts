import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentMessage,
  AgentRuntime,
  type AgentRuntimeOptions,
  COMPACTION_MARKER,
  type CompactionStartedData,
  type ContextCompactedData,
  createAssistantMessage,
  createUserMessage,
  type FileChangedData,
  type HarnessEvent,
  type HarnessEventSink,
  HarnessEventType,
  type MessageCompletedData,
  type ModelClient,
  ModelClientError,
  type ModelRequest,
  type ModelResult,
  type ModelRetryData,
  messageText,
  TodoStatus,
  type TodosUpdatedData,
  type Tool,
  ToolRegistry,
} from "../src/index";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface TestRuntimeOptions {
  autoApprove?: boolean;
  compactionKeepMessages?: number;
  contextTokenLimit?: number;
  initialMessages?: readonly AgentMessage[];
  maxSteps?: number;
  modelClient: ModelClient;
  sink: HarnessEventSink;
  systemPrompt?: string;
  tools?: ToolRegistry;
}

function createTestRuntime(options: TestRuntimeOptions): AgentRuntime {
  const runtimeOptions: AgentRuntimeOptions = {
    autoApprove: () => options.autoApprove ?? true,
    maxTokens: 1024,
    model: "test-model",
    modelClient: options.modelClient,
    sessionId: "m2-session",
    sink: options.sink,
    systemPrompt: options.systemPrompt ?? "test-system",
    tools: options.tools ?? new ToolRegistry(),
    workspaceRoot: process.cwd(),
    ...(options.compactionKeepMessages === undefined
      ? {}
      : { compactionKeepMessages: options.compactionKeepMessages }),
    ...(options.contextTokenLimit === undefined
      ? {}
      : { contextTokenLimit: options.contextTokenLimit }),
    ...(options.initialMessages === undefined ? {} : { initialMessages: options.initialMessages }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  };
  return new AgentRuntime(runtimeOptions);
}

/** 事件 sink 按 emit 顺序收到事件，seq 必须严格 +1 且不重复。 */
function assertSeqStrictlyIncreasing(events: readonly HarnessEvent[]): void {
  assert.ok(events.length > 0, "事件流不应为空");
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    assert.ok(previous !== undefined && current !== undefined);
    assert.equal(
      current.seq,
      previous.seq + 1,
      `seq 应严格递增: ${previous.seq} -> ${current.seq}`,
    );
  }
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
}

// ---------------------------------------------------------------------------
// 1. 运行中排队
// ---------------------------------------------------------------------------

class GatedQueueModel implements ModelClient {
  public calls = 0;
  private readonly firstRelease = deferred();
  private readonly firstStarted = deferred();

  public get firstCallStarted(): Promise<void> {
    return this.firstStarted.promise;
  }

  public releaseFirstCall(): void {
    this.firstRelease.resolve();
  }

  public async stream(
    _request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstStarted.resolve();
      await this.firstRelease.promise;
      onTextDelta("第一段");
      return { content: [{ type: "text", text: "第一段回答" }], stopReason: "end_turn" };
    }
    onTextDelta("第二段");
    return { content: [{ type: "text", text: "第二段回答" }], stopReason: "end_turn" };
  }
}

test("queued input during a run is consumed after the answer and carries queuedInputId", async () => {
  const events: HarnessEvent[] = [];
  const model = new GatedQueueModel();
  const runtime = createTestRuntime({
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
  });

  const { done, runId } = runtime.startRun("开始任务");
  await model.firstCallStarted;
  const queued = runtime.enqueueInput("  排队消息  ");
  assert.deepEqual(
    runtime.queuedInputs.map((item) => item.id),
    [queued.id],
  );

  model.releaseFirstCall();
  await done;

  const queuedEvents = events.filter(
    (event) =>
      event.type === HarnessEventType.MESSAGE_COMPLETED &&
      (event.data as MessageCompletedData).queuedInputId !== undefined,
  );
  assert.equal(queuedEvents.length, 1);
  const queuedData = queuedEvents[0]?.data as MessageCompletedData;
  assert.equal(queuedData.queuedInputId, queued.id);
  const queuedMessage = queuedData.message as AgentMessage;
  assert.equal(queuedMessage.role, "user");
  assert.equal(messageText(queuedMessage), "排队消息");

  assert.equal(model.calls, 2);
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_COMPLETED);
  assert.deepEqual(runtime.queuedInputs, []);
  assert.equal(runtime.isRunning, false);
  assert.equal(runtime.currentRunId, null);

  const history = runtime.history;
  assert.equal(history.length, 4);
  assert.equal(messageText(history[2] as AgentMessage), "排队消息");
  assert.equal(messageText(history[3] as AgentMessage), "第二段回答");

  assert.ok(events.every((event) => event.runId === runId));
  assertSeqStrictlyIncreasing(events);
});

// ---------------------------------------------------------------------------
// 2. 工具结果投影（fileChanges / todos）
// ---------------------------------------------------------------------------

const fileChange = {
  after: "new line\n",
  before: "old line\n",
  diff: "-old line\n+new line\n",
  path: "src/projected.txt",
};

const projectedTodos = [{ content: "完成投影测试", id: "todo-1", status: TodoStatus.IN_PROGRESS }];

function projectionTool(): Tool {
  return {
    description: "returns file and todo projections",
    execute: async () => ({
      content: "wrote src/projected.txt",
      fileChanges: [fileChange],
      todos: projectedTodos,
    }),
    inputSchema: { properties: {}, type: "object" },
    name: "project",
    parse: (input) => input,
    requiresApproval: false,
    summarize: () => "project",
  };
}

class ToolThenTextModel implements ModelClient {
  public calls = 0;
  public readonly requests: ModelRequest[] = [];

  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      onTextDelta("调用工具");
      return {
        content: [{ id: "call-proj-1", input: {}, name: "project", type: "tool_use" }],
        stopReason: "tool_use",
      };
    }
    onTextDelta("完成");
    return { content: [{ type: "text", text: "完成" }], stopReason: "end_turn" };
  }
}

test("tool fileChanges and todos are projected as FILE_CHANGED / TODOS_UPDATED events", async () => {
  const events: HarnessEvent[] = [];
  const model = new ToolThenTextModel();
  const runtime = createTestRuntime({
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
    tools: new ToolRegistry().register(projectionTool()),
  });

  const { done } = runtime.startRun("写文件并更新待办");
  await done;

  const fileEvents = events.filter((event) => event.type === HarnessEventType.FILE_CHANGED);
  assert.equal(fileEvents.length, 1);
  const changed = fileEvents[0]?.data as FileChangedData;
  assert.equal(changed.path, fileChange.path);
  assert.equal(changed.before, fileChange.before);
  assert.equal(changed.after, fileChange.after);
  assert.equal(changed.diff, fileChange.diff);
  assert.equal(changed.toolCallId, "call-proj-1");
  assert.equal(changed.toolName, "project");

  const todoEvents = events.filter((event) => event.type === HarnessEventType.TODOS_UPDATED);
  assert.equal(todoEvents.length, 1);
  const todoData = todoEvents[0]?.data as TodosUpdatedData;
  assert.deepEqual(todoData.todos, projectedTodos);
  assert.deepEqual(runtime.todoList, projectedTodos);

  assert.ok(events.some((event) => event.type === HarnessEventType.TOOL_COMPLETED));
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(runtime.isRunning, false);
  assert.equal(model.calls, 2);

  // 第二次模型请求应看到上一轮的工具结果。
  const secondRequest = model.requests[1];
  assert.ok(secondRequest !== undefined);
  const lastMessage = secondRequest.messages.at(-1);
  const toolResult = lastMessage?.content.find((block) => block.type === "tool_result");
  assert.equal(
    toolResult?.type === "tool_result" ? toolResult.content : undefined,
    "wrote src/projected.txt",
  );

  assertSeqStrictlyIncreasing(events);
});

// ---------------------------------------------------------------------------
// 3. 自动重试
// ---------------------------------------------------------------------------

class RateLimitedModel implements ModelClient {
  public calls = 0;

  public async stream(
    _request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    this.calls += 1;
    if (this.calls <= 2) {
      throw new ModelClientError("RATE_LIMIT", `rate limited #${this.calls}`, { status: 429 });
    }
    onTextDelta("恢复");
    return { content: [{ type: "text", text: "恢复成功" }], stopReason: "end_turn" };
  }
}

test("retryable model errors emit MODEL_RETRY and the run eventually completes", async () => {
  const events: HarnessEvent[] = [];
  const model = new RateLimitedModel();
  const runtime = createTestRuntime({
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
  });

  const { done } = runtime.startRun("重试吧");
  await done;

  const retries = events.filter((event) => event.type === HarnessEventType.MODEL_RETRY);
  assert.equal(retries.length, 2);
  assert.deepEqual(
    retries.map((event) => (event.data as ModelRetryData).attempt),
    [1, 2],
  );
  assert.ok(retries.every((event) => (event.data as ModelRetryData).code === "RATE_LIMIT"));

  assert.equal(model.calls, 3);
  assert.ok(!events.some((event) => event.type === HarnessEventType.RUN_FAILED));
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(runtime.isRunning, false);
  assert.deepEqual(
    runtime.history.map((message) => message.role),
    ["user", "assistant"],
  );
  assertSeqStrictlyIncreasing(events);
});

// ---------------------------------------------------------------------------
// 4. 上下文压缩
// ---------------------------------------------------------------------------

const LONG_TEXT = "x".repeat(3_000);

function longHistory(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? createUserMessage(`用户消息 ${index} ${LONG_TEXT}`, 1_000 + index)
      : createAssistantMessage(
          [{ type: "text", text: `助手消息 ${index} ${LONG_TEXT}` }],
          1_000 + index,
        ),
  );
}

class CompactionModel implements ModelClient {
  public answerCalls = 0;
  public compactionCalls = 0;

  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    if (request.system.includes(COMPACTION_MARKER)) {
      this.compactionCalls += 1;
      return {
        content: [{ type: "text", text: "SUMMARY_OF_EARLY_CHAT" }],
        stopReason: "end_turn",
      };
    }
    this.answerCalls += 1;
    onTextDelta("最终");
    return { content: [{ type: "text", text: "最终回答" }], stopReason: "end_turn" };
  }
}

test("context compaction summarizes old history and keeps the summary at the front", async () => {
  const events: HarnessEvent[] = [];
  const model = new CompactionModel();
  const initialMessages = longHistory(12);
  const runtime = createTestRuntime({
    compactionKeepMessages: 4,
    contextTokenLimit: 1_000,
    initialMessages,
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
  });

  const { done } = runtime.startRun("继续任务");
  await done;

  const startedEvent = events.find(
    (event) => event.type === HarnessEventType.CONTEXT_COMPACTION_STARTED,
  );
  assert.ok(startedEvent !== undefined);
  const started = startedEvent.data as CompactionStartedData;
  assert.equal(started.limit, 1_000);
  assert.ok(started.estimatedTokens > 0);

  const compactedEvents = events.filter(
    (event) => event.type === HarnessEventType.CONTEXT_COMPACTED,
  );
  assert.equal(compactedEvents.length, 1);
  const compacted = compactedEvents[0]?.data as ContextCompactedData;
  assert.equal(compacted.summary, "SUMMARY_OF_EARLY_CHAT");
  assert.equal(compacted.replacedMessages, 8);
  assert.equal(compacted.beforeTokens, started.estimatedTokens);
  assert.ok(
    compacted.afterTokens < compacted.beforeTokens,
    `压缩后 token 应下降: ${compacted.afterTokens} < ${compacted.beforeTokens}`,
  );

  // compactionCount 语义：只统计 summary 非空的 CONTEXT_COMPACTED 事件。
  const compactionCount = compactedEvents.filter((event) => {
    const summary = (event.data as ContextCompactedData).summary;
    return typeof summary === "string" && summary.trim() !== "";
  }).length;
  assert.equal(compactionCount, 1);

  const history = runtime.history;
  assert.equal(history.length, 7);
  const first = history[0] as AgentMessage;
  assert.equal(first.role, "user");
  assert.ok(messageText(first).startsWith("[早期对话摘要]"));
  assert.ok(messageText(first).includes("SUMMARY_OF_EARLY_CHAT"));
  assert.equal(messageText(history.at(-1) as AgentMessage), "最终回答");

  assert.equal(model.compactionCalls, 1);
  assert.equal(model.answerCalls, 1);
  assert.equal(initialMessages.length, 12, "不在压缩过程中修改传入的历史");
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_COMPLETED);
  assert.equal(runtime.isRunning, false);
  assertSeqStrictlyIncreasing(events);
});

// ---------------------------------------------------------------------------
// 5. Abort 清空队列
// ---------------------------------------------------------------------------

class GatedHangingModel implements ModelClient {
  private readonly started = deferred();

  public get startedStream(): Promise<void> {
    return this.started.promise;
  }

  public stream(request: ModelRequest): Promise<ModelResult> {
    this.started.resolve();
    return new Promise<ModelResult>((_resolve, reject) => {
      const onAbort = () => {
        const error = new Error("Request was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

test("abort terminates the run and clears queued inputs", async () => {
  const events: HarnessEvent[] = [];
  const model = new GatedHangingModel();
  const runtime = createTestRuntime({
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
  });

  const { done, runId } = runtime.startRun("长任务");
  await model.startedStream;
  const queued = runtime.enqueueInput("不应执行");
  assert.equal(runtime.queuedInputs.length, 1);

  assert.equal(runtime.abort(runId), true);
  await done;

  assert.deepEqual(runtime.queuedInputs, []);
  assert.equal(runtime.isRunning, false);
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_ABORTED);
  assert.ok(!events.some((event) => event.type === HarnessEventType.RUN_COMPLETED));
  assert.ok(
    !events.some(
      (event) =>
        event.type === HarnessEventType.MESSAGE_COMPLETED &&
        (event.data as MessageCompletedData).queuedInputId === queued.id,
    ),
  );
  assertSeqStrictlyIncreasing(events);
});

test("超窗错误会让 Run 以 CONTEXT_OVERFLOW 失败，而不是当作普通错误", async () => {
  const events: HarnessEvent[] = [];
  const model: ModelClient = {
    async stream(): Promise<ModelResult> {
      throw new ModelClientError("CONTEXT_OVERFLOW", "上下文超过窗口上限");
    },
  };
  const runtime = createTestRuntime({
    modelClient: model,
    sink: (event) => {
      events.push(event);
    },
  });
  const { done } = runtime.startRun("继续任务");
  await done;

  const failed = events.find((event) => event.type === HarnessEventType.RUN_FAILED);
  assert.ok(failed !== undefined);
  assert.equal((failed.data as { code?: string }).code, "CONTEXT_OVERFLOW");
  assert.match((failed.data as { message?: string }).message ?? "", /超过窗口/u);
  assertSeqStrictlyIncreasing(events);
});
