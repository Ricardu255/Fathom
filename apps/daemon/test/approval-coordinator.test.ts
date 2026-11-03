import assert from "node:assert/strict";
import { test } from "node:test";
import { PiApprovalCoordinator } from "../src/pi/approval";
import type { PiToolApprovalInput } from "../src/pi/tools";

function input(overrides: Partial<PiToolApprovalInput> = {}): PiToolApprovalInput {
  return {
    input: { path: "src/a.ts" },
    summary: "写入 src/a.ts",
    target: "src/a.ts",
    toolCallId: "call-1",
    toolName: "write_file",
    ...overrides,
  };
}

async function nextEvent(events: unknown[]): Promise<Record<string, unknown>> {
  for (let index = 0; index < 50; index += 1) {
    if (events.length > 0) return events[0] as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("审批事件未发出");
}

test("会话级授权会跳过同目标后续审批", async () => {
  const events: unknown[] = [];
  const coordinator = new PiApprovalCoordinator(
    async (event) => {
      events.push(event);
      return {} as never;
    },
    () => null,
    () => "request_approval",
  );
  const pending = coordinator.request(input(), undefined);
  const event = await nextEvent(events);
  const data = event.data as Record<string, unknown>;
  assert.equal(coordinator.resolve(String(data.approvalId), true, { grantSession: true }), true);
  assert.equal(await pending, true);

  const second = await coordinator.request(input(), undefined);
  assert.equal(second, true);
});

test("force 审批会绕过自动批准模式，必须等待用户决定", async () => {
  const events: unknown[] = [];
  const coordinator = new PiApprovalCoordinator(
    async (event) => {
      events.push(event);
      return {} as never;
    },
    () => null,
    () => "auto_approve",
  );
  const pending = coordinator.request(input(), undefined, undefined, { force: true });
  const event = await nextEvent(events);
  const data = event.data as Record<string, unknown>;
  assert.equal(coordinator.resolve(String(data.approvalId), true), true);
  assert.equal(await pending, true);
});

test("并发审批可以乱序解决，互不影响", async () => {
  const events: unknown[] = [];
  const coordinator = new PiApprovalCoordinator(
    async (event) => {
      events.push(event);
      return {} as never;
    },
    () => null,
    () => "request_approval",
  );
  const first = coordinator.request(input({ target: "src/a.ts", toolCallId: "call-a" }), undefined);
  const second = coordinator.request(
    input({ target: "src/b.ts", toolCallId: "call-b" }),
    undefined,
  );
  for (let index = 0; index < 50 && events.length < 2; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(events.length, 2);
  const [firstEvent, secondEvent] = events as Array<{ data: Record<string, unknown> }>;
  assert.ok(firstEvent !== undefined && secondEvent !== undefined);

  assert.equal(coordinator.resolve(String(secondEvent.data.approvalId), true), true);
  assert.equal(coordinator.resolve(String(firstEvent.data.approvalId), false), true);
  assert.equal(await first, false);
  assert.equal(await second, true);
});

test("允许类似命令只接受审批事件给出的候选前缀", async () => {
  const events: unknown[] = [];
  let granted: string | null = null;
  const coordinator = new PiApprovalCoordinator(
    async (event) => {
      events.push(event);
      return {} as never;
    },
    () => null,
    () => "request_approval",
    undefined,
    (prefix) => {
      granted = prefix;
    },
  );
  const command = input({
    input: { command: "git status" },
    prefixRule: "git status",
    summary: "git status",
    target: "git status",
    toolName: "run_command",
  });
  const pending = coordinator.request(command, undefined);
  const event = await nextEvent(events);
  const data = event.data as Record<string, unknown>;
  assert.equal(
    coordinator.resolve(String(data.approvalId), true, { allowPrefix: "git diff" }),
    true,
  );
  assert.equal(granted, null);
  assert.equal(await pending, true);

  events.length = 0;
  const second = coordinator.request(command, undefined);
  const secondEvent = await nextEvent(events);
  coordinator.resolve(String((secondEvent.data as Record<string, unknown>).approvalId), true, {
    allowPrefix: "git status",
  });
  assert.equal(granted, "git status");
  assert.equal(await second, true);
});
