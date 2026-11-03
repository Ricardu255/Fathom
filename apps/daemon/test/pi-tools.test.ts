import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@harness/core";
import { executionModeForTool, type PiToolHooks, toPiTools } from "../src/pi/tools";

function fakeTool(name: string): Tool {
  return {
    description: name,
    execute: async () => ({ content: "" }),
    inputSchema: {},
    name,
    parse: (input) => input,
    requiresApproval: false,
    summarize: () => name,
  };
}

const hooks: PiToolHooks = {
  onResult: () => undefined,
  requestApproval: async () => true,
  workspaceRoot: ".",
};

test("只读工具并行，副作用工具串行", () => {
  const readOnly = [
    "find_skill",
    "get_skill",
    "list_background_commands",
    "list_files",
    "load_skill",
    "read_background_command",
    "read_document",
    "read_file",
    "search_history",
    "search_knowledge",
    "search_memory",
    "search_text",
    "view_image",
    "view_pdf_page",
    "web_fetch",
    "web_search",
  ];
  const sideEffect = [
    "edit_file",
    "forget_memory",
    "request_user_input",
    "run_command",
    "run_workflow",
    "save_memory",
    "send_agent",
    "skill_creator",
    "spawn_agent",
    "start_background_command",
    "stop_agent",
    "stop_background_command",
    "update_todos",
    "wait_agents",
    "wait_background_command",
    "write_file",
  ];

  for (const name of readOnly) {
    assert.equal(executionModeForTool({ name }), "parallel", name);
  }
  for (const name of sideEffect) {
    assert.equal(executionModeForTool({ name }), "sequential", name);
  }

  const definitions = toPiTools([...readOnly, ...sideEffect].map(fakeTool), hooks);
  for (const name of readOnly) {
    assert.equal(
      definitions.find((definition) => definition.name === name)?.executionMode,
      "parallel",
    );
  }
  for (const name of sideEffect) {
    assert.equal(
      definitions.find((definition) => definition.name === name)?.executionMode,
      "sequential",
    );
  }
});
