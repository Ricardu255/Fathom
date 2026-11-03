import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@harness/core";
import { toPiTools } from "../src/pi/tools";

test("计划模式在审批前阻断副作用工具", async () => {
  let executed = false;
  let approvalRequested = false;
  const tool: Tool = {
    description: "write",
    async execute() {
      executed = true;
      return { content: "written" };
    },
    inputSchema: { properties: {}, type: "object" },
    name: "write_file",
    parse: (input) => input,
    requiresApproval: true,
    summarize: () => "写入文件",
  };

  const [definition] = toPiTools([tool], {
    blockedToolReason: (toolName) => (toolName === "write_file" ? "计划模式禁止写入" : undefined),
    onResult: () => undefined,
    requestApproval: async () => {
      approvalRequested = true;
      return true;
    },
    workspaceRoot: "/tmp/workspace",
  });
  assert.ok(definition !== undefined);
  const execute = definition.execute as unknown as (
    id: string,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<{ content: { text?: string; type: string }[]; isError?: boolean }>;
  const result = await execute("call-1", {}, new AbortController().signal);
  assert.equal(result.isError, true);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === "text");
  assert.equal(block.type, "text");
  assert.match(block.text ?? "", /计划模式禁止写入/u);
  assert.equal(executed, false);
  assert.equal(approvalRequested, false);
});
