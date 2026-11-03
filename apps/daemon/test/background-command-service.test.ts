import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  BackgroundCommandService,
  BackgroundCommandServiceError,
} from "../src/services/background-command-service";

let root = "";
let service: BackgroundCommandService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-background-command-"));
  service = new BackgroundCommandService();
});

after(async () => {
  service.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("后台命令可以启动、读取输出并记录退出码", { timeout: 15_000 }, async () => {
  const started = service.start({
    command: "node -e \"console.log('bg-ok')\"",
    name: "echo",
    sessionId: "session-1",
    workspaceRoot: root,
  });
  assert.equal(started.status, "running");
  assert.equal(service.list("session-1").length, 1);

  const finished = await waitFor(() => {
    const command = service.get("session-1", started.id);
    return command.status === "running" ? undefined : command;
  });
  assert.equal(finished.status, "exited");
  assert.equal(finished.exitCode, 0);
  assert.match(finished.stdout, /bg-ok/u);
});

test("停止长驻命令后状态为 stopped，且 Session 隔离", { timeout: 15_000 }, async () => {
  const started = service.start({
    command: 'node -e "setInterval(() => {}, 1000)"',
    name: "long-running",
    sessionId: "session-2",
    workspaceRoot: root,
  });
  assert.equal(
    service.list("session-1").some((item) => item.id === started.id),
    false,
  );
  const stopped = service.stop("session-2", started.id);
  assert.equal(stopped.status, "stopped");
  assert.throws(
    () => service.get("session-1", started.id),
    (error: unknown) =>
      error instanceof BackgroundCommandServiceError && error.code === "NOT_FOUND",
  );
});

test("拒绝空命令", () => {
  assert.throws(
    () =>
      service.start({
        command: "   ",
        sessionId: "session-1",
        workspaceRoot: root,
      }),
    (error: unknown) => error instanceof BackgroundCommandServiceError && error.code === "INVALID",
  );
});

test("后台命令只继承白名单环境变量", { timeout: 15_000 }, async () => {
  process.env.HARNESS_TEST_SECRET = "should-not-leak";
  const isolated = new BackgroundCommandService();
  try {
    const started = isolated.start({
      command: "node -e \"console.log(process.env.HARNESS_TEST_SECRET ?? 'missing')\"",
      sessionId: "session-env",
      workspaceRoot: root,
    });
    const finished = await waitFor(() => {
      const command = isolated.get("session-env", started.id);
      return command.status === "running" ? undefined : command;
    });
    assert.match(finished.stdout, /missing/u);
    assert.doesNotMatch(finished.stdout, /should-not-leak/u);
  } finally {
    isolated.stopAll();
    delete process.env.HARNESS_TEST_SECRET;
  }
});

test("后台命令有每 Session 并发上限", { timeout: 15_000 }, async () => {
  const limited = new BackgroundCommandService({ maxActivePerSession: 1 });
  try {
    const first = limited.start({
      command: 'node -e "setInterval(() => {}, 1000)"',
      sessionId: "session-limit",
      workspaceRoot: root,
    });
    assert.throws(
      () =>
        limited.start({
          command: 'node -e "setInterval(() => {}, 1000)"',
          sessionId: "session-limit",
          workspaceRoot: root,
        }),
      (error: unknown) => error instanceof BackgroundCommandServiceError && error.code === "LIMIT",
    );
    limited.stop("session-limit", first.id);
  } finally {
    limited.stopAll();
  }
});

test("沙箱 Profile 下拒绝后台命令，不静默绕过", () => {
  const sandboxed = new BackgroundCommandService({
    getApprovalMode: () => "request_approval",
    getSandboxSettings: () => ({ profile: "workspace_write" }),
  });
  assert.throws(
    () =>
      sandboxed.start({
        command: 'node -e "console.log(1)"',
        sessionId: "session-sandbox",
        workspaceRoot: root,
      }),
    (error: unknown) =>
      error instanceof BackgroundCommandServiceError && error.code === "SANDBOX_UNSUPPORTED",
  );
});

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("等待后台命令退出超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
