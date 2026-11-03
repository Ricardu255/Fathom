import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@harness/core";
import { toPiTools } from "../src/pi/tools";

async function executeTool(tool: { execute: unknown }): Promise<{ isError?: boolean }> {
  const execute = tool.execute as (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<{ isError?: boolean }>;
  return execute("call-1", {}, undefined);
}

function writeTool(executed: { count: number }): Tool {
  return {
    description: "写文件",
    async execute() {
      executed.count += 1;
      return { content: "executed" };
    },
    inputSchema: { properties: {}, type: "object" },
    name: "write_file",
    parse: (input) => input,
    requiresApproval: true,
    summarize: () => "写入文件",
  };
}

test("沙箱拒绝后会请求一次强制宿主审批，批准后执行且不再走普通审批", async () => {
  const executed = { count: 0 };
  let requests = 0;
  let forced = false;
  const [piTool] = toPiTools([writeTool(executed)], {
    onResult: () => undefined,
    requestApproval: async (_input, _signal, options) => {
      requests += 1;
      forced = options?.force === true;
      return true;
    },
    sandboxBlockedReason: () => "沙箱 read_only 模式禁止写文件",
    workspaceRoot: process.cwd(),
  });
  assert.ok(piTool !== undefined);
  const result = await executeTool(piTool);
  assert.equal(executed.count, 1);
  assert.equal(requests, 1);
  assert.equal(forced, true);
  assert.equal(result.isError, undefined);
});

test("宿主审批被拒绝时不执行工具", async () => {
  const executed = { count: 0 };
  const [piTool] = toPiTools([writeTool(executed)], {
    onResult: () => undefined,
    requestApproval: async () => false,
    sandboxBlockedReason: () => "沙箱 read_only 模式禁止写文件",
    workspaceRoot: process.cwd(),
  });
  assert.ok(piTool !== undefined);
  const result = await executeTool(piTool);
  assert.equal(executed.count, 0);
  assert.equal(result.isError, true);
});

test("计划模式的硬阻断不能被宿主审批绕过", async () => {
  const executed = { count: 0 };
  let requested = false;
  const [piTool] = toPiTools([writeTool(executed)], {
    blockedToolReason: () => "计划模式禁止写文件",
    onResult: () => undefined,
    requestApproval: async () => {
      requested = true;
      return true;
    },
    sandboxBlockedReason: () => "沙箱拒绝",
    workspaceRoot: process.cwd(),
  });
  assert.ok(piTool !== undefined);
  const result = await executeTool(piTool);
  assert.equal(executed.count, 0);
  assert.equal(requested, false);
  assert.equal(result.isError, true);
});
