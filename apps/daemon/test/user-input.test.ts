import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserInputAnswer, UserInputQuestion } from "@harness/core";
import type { PiBridgeEmit } from "../src/pi/event-bridge";
import { UserInputCoordinator, UserInputError } from "../src/pi/user-input-coordinator";
import { createUserInputTool } from "../src/pi/user-input-tool";

interface Emitted {
  data: Record<string, unknown>;
  runId: string | null;
  type: string;
}

function createHarness(runId: string | null = "run-1") {
  const events: Emitted[] = [];
  const emit: PiBridgeEmit = async (draft) => {
    events.push({
      data: draft.data as Record<string, unknown>,
      runId: draft.runId,
      type: draft.type,
    });
    return {} as never;
  };
  return { coordinator: new UserInputCoordinator(emit, () => runId), events };
}

function question(overrides: Partial<UserInputQuestion> = {}): UserInputQuestion {
  return {
    allowCustomInput: true,
    body: "",
    id: "q1",
    multiSelect: false,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    title: "选一个",
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function inputIdOf(events: readonly Emitted[], type: string, index = 0): string {
  const event = events.filter((item) => item.type === type)[index];
  assert.ok(event !== undefined, `缺少 ${type} 事件`);
  const inputId = event.data.inputId;
  assert.equal(typeof inputId, "string");
  return inputId as string;
}

test("提问会发出 input.requested，回答后发出 input.resolved 并返回答案", async () => {
  const { coordinator, events } = createHarness();
  const pending = coordinator.request({ questions: [question()] }, undefined);
  await flush();

  assert.equal(events[0]?.type, "input.requested");
  assert.equal(events[0]?.runId, "run-1");
  const inputId = inputIdOf(events, "input.requested");
  const answers: UserInputAnswer[] = [{ questionId: "q1", selectedOption: "a", value: "A" }];

  assert.equal(await coordinator.resolve(inputId, answers), true);
  assert.deepEqual(await pending, answers);

  const resolved = events.find((event) => event.type === "input.resolved");
  assert.ok(resolved !== undefined);
  assert.deepEqual(resolved.data.answers, answers);
});

test("多个提问可并发等待；重复提交只接受第一次", async () => {
  const { coordinator, events } = createHarness();
  const first = coordinator.request({ questions: [question()] }, undefined);
  const second = coordinator.request(
    { questions: [question({ id: "q2", title: "第二个问题" })] },
    undefined,
  );
  await flush();
  assert.equal(events.filter((event) => event.type === "input.requested").length, 2);

  const firstId = inputIdOf(events, "input.requested", 0);
  const secondId = inputIdOf(events, "input.requested", 1);
  const firstAnswer: UserInputAnswer[] = [{ questionId: "q1", selectedOption: "a", value: "A" }];
  const secondAnswer: UserInputAnswer[] = [{ questionId: "q2", selectedOption: "b", value: "B" }];

  assert.equal(await coordinator.resolve(firstId, firstAnswer), true);
  assert.equal(await coordinator.resolve(firstId, firstAnswer), false);
  assert.equal(await coordinator.resolve(secondId, secondAnswer), true);
  assert.deepEqual(await first, firstAnswer);
  assert.deepEqual(await second, secondAnswer);
});

test("回答不完整或选项无效时抛 INVALID，且提问仍可重新提交", async () => {
  const { coordinator, events } = createHarness();
  const pending = coordinator.request({ questions: [question()] }, undefined);
  await flush();
  const inputId = inputIdOf(events, "input.requested");

  await assert.rejects(
    () =>
      coordinator.resolve(inputId, [
        { questionId: "q1", selectedOption: "missing", value: "不存在" },
      ]),
    (error: unknown) => error instanceof UserInputError && error.code === "INVALID",
  );
  await assert.rejects(
    () => coordinator.resolve(inputId, []),
    (error: unknown) => error instanceof UserInputError && error.code === "INVALID",
  );

  const valid: UserInputAnswer[] = [{ questionId: "q1", selectedOption: "a", value: "A" }];
  assert.equal(await coordinator.resolve(inputId, valid), true);
  assert.deepEqual(await pending, valid);
});

test("超时会发出 input.expired(timeout) 并拒绝等待", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { coordinator, events } = createHarness();
  const pending = coordinator.request({ questions: [question()], timeoutMs: 10_000 }, undefined);
  await flush();

  const rejection = assert.rejects(pending, /超时/);
  t.mock.timers.tick(10_000);
  await rejection;
  await flush();

  const expired = events.find((event) => event.type === "input.expired");
  assert.ok(expired !== undefined);
  assert.equal(expired.data.reason, "timeout");
});

test("AbortSignal 会中止等待并发出 input.expired(aborted)", async () => {
  const { coordinator, events } = createHarness();
  const controller = new AbortController();
  const pending = coordinator.request({ questions: [question()] }, controller.signal);
  await flush();

  const rejection = assert.rejects(pending, /中止/);
  controller.abort();
  await rejection;
  await flush();

  const expired = events.find((event) => event.type === "input.expired");
  assert.ok(expired !== undefined);
  assert.equal(expired.data.reason, "aborted");
});

test("cancelAll 收口所有并发提问", async () => {
  const { coordinator, events } = createHarness();
  const first = coordinator.request({ questions: [question()] }, undefined);
  const second = coordinator.request({ questions: [question({ id: "q2" })] }, undefined);
  await flush();

  const firstRejection = assert.rejects(first, /中止/);
  const secondRejection = assert.rejects(second, /中止/);
  coordinator.cancelAll();
  await Promise.all([firstRejection, secondRejection]);
  await flush();

  assert.equal(events.filter((event) => event.type === "input.expired").length, 2);
});

test("子 Agent 提问会携带 executionId，解决事件保持归属", async () => {
  const { coordinator, events } = createHarness();
  const pending = coordinator.request(
    { executionId: "exec-1", questions: [question()] },
    undefined,
  );
  await flush();

  const requested = events.find((event) => event.type === "input.requested");
  assert.ok(requested !== undefined);
  assert.equal(requested.data.executionId, "exec-1");

  const inputId = inputIdOf(events, "input.requested");
  await coordinator.resolve(inputId, [{ questionId: "q1", selectedOption: "a", value: "A" }]);
  await pending;
  const resolved = events.find((event) => event.type === "input.resolved");
  assert.ok(resolved !== undefined);
  assert.equal(resolved.data.executionId, "exec-1");
});

test("request_user_input 工具不需要审批，返回格式化回答", async () => {
  const { coordinator, events } = createHarness();
  const tool = createUserInputTool(coordinator);
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.name, "request_user_input");
  const input = { questions: [question()] };
  const pending = tool.execute(input, {
    signal: new AbortController().signal,
    workspaceRoot: process.cwd(),
  });
  await flush();

  const inputId = inputIdOf(events, "input.requested");
  await coordinator.resolve(inputId, [{ questionId: "q1", selectedOption: "b", value: "B" }]);
  const result = await pending;
  assert.equal(result.content, "q1: B");
  assert.equal(tool.summarize(input), "向用户提问：选一个");
});
