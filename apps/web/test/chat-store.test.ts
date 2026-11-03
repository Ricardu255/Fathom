/// <reference types="node" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type {
  AgentMessage,
  ApprovalRequestedData,
  FileChange,
  HarnessEvent,
  HarnessEventType as HarnessEventTypeAlias,
  TodoItem,
  UsageData,
} from "@harness/core";
import { HarnessEventType } from "@harness/core/events";
import type { QueuedInput, SessionSnapshot } from "../src/api/types";
import { useChatStore } from "../src/stores/chat-store";

const session = {
  archivedAt: null,
  createdAt: 1,
  id: "session-1",
  lastSeq: 0,
  modelId: "claude-sonnet-5-5",
  parentSessionId: null,
  providerId: "anthropic",
  thinkingLevel: "medium",
  title: "test session",
  updatedAt: 1,
  workspaceId: "workspace-1",
  workspaceRoot: "/tmp/workspace",
} as const;

let eventCounter = 0;

function makeEvent<T>(
  type: HarnessEventTypeAlias,
  seq: number,
  data: T,
  overrides: { runId?: string | null; sessionId?: string } = {},
): HarnessEvent<T> {
  eventCounter += 1;
  return {
    data,
    id: `event-${eventCounter}`,
    runId: overrides.runId === undefined ? "run-1" : overrides.runId,
    seq,
    sessionId: overrides.sessionId ?? session.id,
    timestamp: 1_000 + eventCounter,
    type,
  };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    approvals: [],
    attachments: null,
    compactionCount: 0,
    fileChanges: [],
    isRunning: false,
    lastSeq: 0,
    lastUsage: null,
    memoryRecall: null,
    messages: [],
    plan: null,
    queued: [],
    runId: null,
    session: { ...session },
    todos: [],
    ...overrides,
  };
}

function textMessage(text: string, role: AgentMessage["role"] = "user"): AgentMessage {
  return { content: [{ text, type: "text" }], role, timestamp: 10 };
}

function toolResultOnlyMessage(): AgentMessage {
  return {
    content: [{ content: "tool output", toolUseId: "tool-1", type: "tool_result" }],
    role: "user",
    timestamp: 11,
  };
}

function makeTodo(id: string, content: string): TodoItem {
  return { content, id, status: "pending" };
}

function makeQueued(id: string): QueuedInput {
  return { createdAt: 1, id, text: `queued ${id}` };
}

function makeUsage(inputTokens: number): UsageData {
  return { inputTokens, model: "test-model", outputTokens: inputTokens * 2 };
}

function makeFileChange(path: string, diff: string): FileChange {
  return { after: null, before: null, diff, path };
}

function makeFileChangedData(path: string, diff: string) {
  return { ...makeFileChange(path, diff), toolCallId: "tool-1", toolName: "edit" };
}

beforeEach(() => {
  useChatStore.getState().reset();
});

test("hydrate populates state from snapshot and filters tool-result-only messages", () => {
  const userMessage = textMessage("hello");
  const assistantMessage = textMessage("hi", "assistant");
  const fileChanges = [makeFileChange("a.ts", "diff-a")];
  const todos = [makeTodo("todo-1", "do it")];
  const queued = [makeQueued("queued-1")];
  const usage = makeUsage(12);
  const tools = [
    {
      id: "tool-1",
      input: { path: "a.ts" },
      name: "read_file",
      result: "file contents",
      status: "completed" as const,
    },
  ];

  useChatStore.getState().hydrate(
    session.id,
    makeSnapshot({
      compactionCount: 2,
      fileChanges,
      isRunning: true,
      lastSeq: 42,
      lastUsage: usage,
      messages: [userMessage, toolResultOnlyMessage(), assistantMessage],
      queued,
      runId: "run-9",
      todos,
      tools,
    }),
  );

  const state = useChatStore.getState();
  assert.equal(state.sessionId, session.id);
  assert.equal(state.hydrated, true);
  assert.deepEqual(state.messages, [userMessage, assistantMessage]);
  assert.deepEqual(state.todos, todos);
  assert.deepEqual(state.tools, tools);
  assert.deepEqual(state.fileChanges, fileChanges);
  assert.deepEqual(state.queued, queued);
  assert.deepEqual(state.lastUsage, usage);
  assert.equal(state.compactionCount, 2);
  assert.equal(state.isRunning, true);
  assert.equal(state.runId, "run-9");
  assert.equal(state.lastSeq, 42);
});

test("hydrate does not overwrite live state on a second call for the same session", () => {
  const firstMessage = textMessage("first");
  useChatStore
    .getState()
    .hydrate(session.id, makeSnapshot({ messages: [firstMessage], lastSeq: 3 }));

  useChatStore.getState().setError("live error");
  useChatStore.getState().setQueued([makeQueued("live-queued")]);
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TEXT_DELTA, 4, { text: "live delta" }));

  useChatStore.getState().hydrate(
    session.id,
    makeSnapshot({
      compactionCount: 99,
      isRunning: true,
      lastSeq: 999,
      messages: [textMessage("replacement")],
      queued: [makeQueued("snapshot-queued")],
      runId: "other-run",
      todos: [makeTodo("snapshot-todo", "snapshot")],
    }),
  );

  const state = useChatStore.getState();
  assert.equal(state.hydrated, true);
  assert.equal(state.sessionId, session.id);
  assert.deepEqual(state.messages, [firstMessage]);
  assert.equal(state.error, "live error");
  assert.deepEqual(state.queued, [makeQueued("live-queued")]);
  assert.equal(state.lastSeq, 4);
  assert.equal(state.streamingText, "live delta");
  assert.equal(state.runId, null);
  assert.equal(state.compactionCount, 0);
  assert.deepEqual(state.todos, []);
});

test("applyEvent ignores events whose seq is not greater than lastSeq", () => {
  useChatStore.getState().hydrate(session.id, makeSnapshot({ lastSeq: 5 }));

  const replacementTodos = [makeTodo("new", "new todo")];
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TODOS_UPDATED, 5, { todos: replacementTodos }));
  assert.deepEqual(useChatStore.getState().todos, []);

  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TODOS_UPDATED, 3, { todos: replacementTodos }));
  assert.deepEqual(useChatStore.getState().todos, []);
  assert.equal(useChatStore.getState().lastSeq, 5);

  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TODOS_UPDATED, 6, { todos: replacementTodos }));
  assert.deepEqual(useChatStore.getState().todos, replacementTodos);
  assert.equal(useChatStore.getState().lastSeq, 6);

  // Replaying the same event id/seq must not apply it twice.
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TODOS_UPDATED, 6, { todos: [makeTodo("dup", "dup")] }));
  assert.deepEqual(useChatStore.getState().todos, replacementTodos);
});

test("FILE_CHANGED appends changes and deduplicates by path plus diff", () => {
  const first = makeFileChangedData("a.ts", "diff-1");
  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.FILE_CHANGED, 1, first));
  assert.deepEqual(useChatStore.getState().fileChanges, [makeFileChange("a.ts", "diff-1")]);

  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.FILE_CHANGED, 2, first));
  assert.equal(useChatStore.getState().fileChanges.length, 1);

  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.FILE_CHANGED, 3, makeFileChangedData("a.ts", "diff-2")));
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.FILE_CHANGED, 4, makeFileChangedData("b.ts", "diff-1")));
  assert.deepEqual(useChatStore.getState().fileChanges, [
    makeFileChange("a.ts", "diff-1"),
    makeFileChange("a.ts", "diff-2"),
    makeFileChange("b.ts", "diff-1"),
  ]);
});

test("FILE_CHANGED keeps at most the latest 100 changes", () => {
  for (let index = 1; index <= 101; index += 1) {
    useChatStore
      .getState()
      .applyEvent(
        makeEvent(
          HarnessEventType.FILE_CHANGED,
          index,
          makeFileChangedData(`file-${index}.ts`, `diff-${index}`),
        ),
      );
  }

  const changes = useChatStore.getState().fileChanges;
  assert.equal(changes.length, 100);
  assert.equal(changes[0]?.path, "file-2.ts");
  assert.equal(changes.at(-1)?.path, "file-101.ts");
});

test("TODOS_UPDATED replaces the todo list", () => {
  useChatStore.getState().hydrate(session.id, makeSnapshot({ todos: [makeTodo("old-1", "old")] }));

  const nextTodos = [makeTodo("new-1", "first"), makeTodo("new-2", "second")];
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.TODOS_UPDATED, 1, { todos: nextTodos }));

  assert.deepEqual(useChatStore.getState().todos, nextTodos);
});

test("MESSAGE_COMPLETED removes the matching queued input and skips hidden/tool-result-only messages", () => {
  useChatStore
    .getState()
    .hydrate(
      session.id,
      makeSnapshot({ queued: [makeQueued("queued-1"), makeQueued("queued-2")] }),
    );

  const visibleMessage = textMessage("answer", "assistant");
  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.MESSAGE_COMPLETED, 1, {
      message: visibleMessage,
      queuedInputId: "queued-1",
    }),
  );

  let state = useChatStore.getState();
  assert.deepEqual(state.messages, [visibleMessage]);
  assert.deepEqual(state.queued, [makeQueued("queued-2")]);
  assert.equal(state.streamingText, "");

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.MESSAGE_COMPLETED, 2, {
      hidden: true,
      message: textMessage("hidden", "assistant"),
      queuedInputId: "queued-2",
    }),
  );

  state = useChatStore.getState();
  assert.deepEqual(state.messages, [visibleMessage]);
  assert.deepEqual(state.queued, []);

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.MESSAGE_COMPLETED, 3, {
      message: toolResultOnlyMessage(),
    }),
  );

  state = useChatStore.getState();
  assert.deepEqual(state.messages, [visibleMessage]);
});

test("CONTEXT_COMPACTED only increments compactionCount for a non-empty summary and resets isCompacting", () => {
  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.CONTEXT_COMPACTION_STARTED, 1, {
      estimatedTokens: 100,
      limit: 50,
    }),
  );
  assert.equal(useChatStore.getState().isCompacting, true);

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.CONTEXT_COMPACTED, 2, {
      afterTokens: 10,
      beforeTokens: 20,
      replacedMessages: 3,
      summary: "   ",
    }),
  );
  assert.equal(useChatStore.getState().compactionCount, 0);
  assert.equal(useChatStore.getState().isCompacting, false);

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.CONTEXT_COMPACTION_STARTED, 3, {
      estimatedTokens: 100,
      limit: 50,
    }),
  );
  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.CONTEXT_COMPACTED, 4, {
      afterTokens: 10,
      beforeTokens: 20,
      replacedMessages: 3,
      summary: "summary",
    }),
  );
  assert.equal(useChatStore.getState().compactionCount, 1);
  assert.equal(useChatStore.getState().isCompacting, false);

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.CONTEXT_COMPACTED, 5, {
      afterTokens: 10,
      beforeTokens: 20,
      replacedMessages: 3,
      summary: "another summary",
    }),
  );
  assert.equal(useChatStore.getState().compactionCount, 2);
});

test("USAGE updates lastUsage and RUN_FAILED records the error and clears run state", () => {
  const usage = makeUsage(7);
  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.USAGE, 1, usage));
  assert.deepEqual(useChatStore.getState().lastUsage, usage);

  useChatStore.getState().setQueued([makeQueued("queued-1")]);
  const approval: ApprovalRequestedData = {
    approvalId: "approval-1",
    input: {},
    summary: "run it",
    toolCallId: "tool-1",
    toolName: "bash",
  };
  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.APPROVAL_REQUESTED, 2, approval));
  assert.deepEqual(useChatStore.getState().approvals, { "approval-1": approval });
  assert.equal(useChatStore.getState().isRunning, true);

  useChatStore
    .getState()
    .applyEvent(
      makeEvent(HarnessEventType.RUN_FAILED, 3, { code: "boom", message: "something failed" }),
    );

  const state = useChatStore.getState();
  assert.equal(state.error, "something failed");
  assert.equal(state.isRunning, false);
  assert.equal(state.isCompacting, false);
  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.approvals, {});
  assert.equal(state.runId, null);
  assert.deepEqual(state.lastUsage, usage);
});

test("PLAN_CREATED 展示计划，新 Run 开始时清空计划与 Todos", () => {
  useChatStore.getState().reset();
  useChatStore
    .getState()
    .applyEvent(
      makeEvent(HarnessEventType.PLAN_CREATED, 1, { planId: "plan-1", text: "先读文件" }),
    );
  useChatStore
    .getState()
    .applyEvent(
      makeEvent(HarnessEventType.TODOS_UPDATED, 2, { todos: [makeTodo("old-todo", "旧任务")] }),
    );
  assert.equal(useChatStore.getState().plan?.planId, "plan-1");
  assert.equal(useChatStore.getState().todos.length, 1);
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.RUN_STARTED, 3, { model: "mock", tools: [] }));
  assert.equal(useChatStore.getState().plan, null);
  assert.deepEqual(useChatStore.getState().todos, []);
});

test("MEMORY_RECALLED 更新注入标记，空召回会清空", () => {
  useChatStore.getState().reset();
  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.MEMORY_RECALLED, 1, {
      memoryIds: ["m1"],
      titles: ["偏好"],
    }),
  );
  assert.deepEqual(useChatStore.getState().memoryRecall, {
    memoryIds: ["m1"],
    titles: ["偏好"],
  });
  useChatStore
    .getState()
    .applyEvent(makeEvent(HarnessEventType.MEMORY_RECALLED, 2, { memoryIds: [], titles: [] }));
  assert.equal(useChatStore.getState().memoryRecall, null);
});

test("多个审批同时挂起时只移除已解决的那一个", () => {
  useChatStore.getState().reset();
  const first: ApprovalRequestedData = {
    approvalId: "approval-1",
    input: { path: "a.ts" },
    summary: "写入 a.ts",
    toolCallId: "tool-1",
    toolName: "write_file",
  };
  const second: ApprovalRequestedData = {
    approvalId: "approval-2",
    executionId: "exec-1",
    input: { command: "npm test" },
    summary: "执行测试",
    toolCallId: "tool-2",
    toolName: "run_command",
  };
  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.APPROVAL_REQUESTED, 1, first));
  useChatStore.getState().applyEvent(makeEvent(HarnessEventType.APPROVAL_REQUESTED, 2, second));
  assert.deepEqual(Object.keys(useChatStore.getState().approvals).sort(), [
    "approval-1",
    "approval-2",
  ]);

  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.APPROVAL_RESOLVED, 3, {
      approvalId: "approval-1",
      decision: "approved",
    }),
  );
  assert.deepEqual(useChatStore.getState().approvals, { "approval-2": second });
});

test("reset restores the initial state", () => {
  useChatStore.getState().hydrate(
    session.id,
    makeSnapshot({
      compactionCount: 4,
      fileChanges: [makeFileChange("a.ts", "diff")],
      isRunning: true,
      lastSeq: 12,
      lastUsage: makeUsage(5),
      messages: [textMessage("hello")],
      queued: [makeQueued("queued-1")],
      runId: "run-1",
      todos: [makeTodo("todo-1", "todo")],
    }),
  );
  useChatStore.getState().setError("error");
  useChatStore.getState().applyEvent(
    makeEvent(HarnessEventType.APPROVAL_REQUESTED, 13, {
      approvalId: "approval-1",
      input: {},
      summary: "run it",
      toolCallId: "tool-1",
      toolName: "bash",
    } satisfies ApprovalRequestedData),
  );

  useChatStore.getState().reset();

  const state = useChatStore.getState();
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.todos, []);
  assert.deepEqual(state.fileChanges, []);
  assert.deepEqual(state.queued, []);
  assert.deepEqual(state.tools, []);
  assert.equal(state.lastUsage, null);
  assert.equal(state.compactionCount, 0);
  assert.equal(state.isRunning, false);
  assert.equal(state.isCompacting, false);
  assert.equal(state.runId, null);
  assert.equal(state.sessionId, null);
  assert.equal(state.hydrated, false);
  assert.equal(state.lastSeq, 0);
  assert.equal(state.error, null);
  assert.deepEqual(state.approvals, {});
  assert.equal(state.streamingText, "");
  assert.equal(state.retryNotice, null);
});
