import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutionGuard, ToolExecutionGuardError } from "../src/pi/tool-guard";

const ok = { content: "ok" } as const;

test("同参数副作用工具去重，读工具与不同参数不去重", async () => {
  const guard = new ToolExecutionGuard();
  let writes = 0;
  const write = () =>
    guard.run("write_file", { path: "a.txt", content: "x" }, undefined, async () => {
      writes += 1;
      return ok;
    });
  assert.equal((await write()).content, "ok");
  assert.equal((await write()).content, "ok");
  assert.equal(writes, 1);

  await guard.run("write_file", { content: "x", path: "b.txt" }, undefined, async () => {
    writes += 1;
    return ok;
  });
  assert.equal(writes, 2);

  let reads = 0;
  const read = () =>
    guard.run("read_file", { path: "a.txt" }, undefined, async () => {
      reads += 1;
      return ok;
    });
  await read();
  await read();
  assert.equal(reads, 2);

  guard.reset();
  await write();
  assert.equal(writes, 3);
});

test("失败结果不缓存，可以重试", async () => {
  const guard = new ToolExecutionGuard();
  let calls = 0;
  const run = () =>
    guard.run("run_command", { command: "false" }, undefined, async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return ok;
    });
  await assert.rejects(run, /boom/u);
  assert.equal((await run()).content, "ok");
  assert.equal(calls, 2);
});

test("超时会拒绝，即使工具不响应 AbortSignal", async () => {
  const guard = new ToolExecutionGuard({ timeoutMs: 30 });
  await assert.rejects(
    () =>
      guard.run("write_file", { path: "slow" }, undefined, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return ok;
      }),
    (error: unknown) => error instanceof ToolExecutionGuardError && error.code === "TIMEOUT",
  );
});

test("并发上限生效", async () => {
  const guard = new ToolExecutionGuard({ maxConcurrency: 2 });
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    [1, 2, 3, 4].map((index) =>
      guard.run("read_file", { index }, undefined, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return ok;
      }),
    ),
  );
  assert.ok(maxActive <= 2, `最大并发 ${maxActive} 超过 2`);
});
