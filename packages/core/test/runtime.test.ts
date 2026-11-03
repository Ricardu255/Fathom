import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentRuntime,
  type HarnessEvent,
  HarnessEventType,
  type ModelClient,
  type ModelRequest,
  type ModelResult,
  type Tool,
  ToolRegistry,
} from "../src/index";

class ScriptedModel implements ModelClient {
  public calls = 0;

  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    this.calls += 1;
    if (this.calls === 1) {
      onTextDelta("先调用工具。");
      return {
        content: [{ id: "tool-1", input: { text: "hi" }, name: "echo", type: "tool_use" }],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    const last = request.messages.at(-1);
    const result = last?.content.find((block) => block.type === "tool_result");
    onTextDelta("完成。");
    return {
      content: [
        {
          text: result?.type === "tool_result" ? `工具结果: ${result.content}` : "没有工具结果",
          type: "text",
        },
      ],
      stopReason: "end_turn",
    };
  }
}

class HangingModel implements ModelClient {
  public stream(request: ModelRequest): Promise<ModelResult> {
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("Request was aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  }
}

function echoTool(): Tool {
  return {
    description: "echo",
    execute: async (input) => ({ content: `echo:${(input as { text: string }).text}` }),
    inputSchema: { properties: {}, type: "object" },
    name: "echo",
    parse: (input) => input,
    requiresApproval: true,
    summarize: (input) => `echo ${(input as { text: string }).text}`,
  };
}

test("runtime emits an ordered event stream and executes an approved tool", async () => {
  const events: HarnessEvent[] = [];
  const runtime = new AgentRuntime({
    autoApprove: () => false,
    maxTokens: 1024,
    model: "test-model",
    modelClient: new ScriptedModel(),
    sessionId: "session-1",
    sink: (event) => {
      events.push(event);
      if (event.type === HarnessEventType.APPROVAL_REQUESTED) {
        const data = event.data as { approvalId: string };
        queueMicrotask(() => runtime.resolveApproval(data.approvalId, true));
      }
    },
    systemPrompt: "test",
    tools: new ToolRegistry().register(echoTool()),
    workspaceRoot: process.cwd(),
  });

  const { done, runId } = runtime.startRun("请调用工具");
  await done;

  const types = events.map((event) => event.type);
  assert.equal(types[0], HarnessEventType.RUN_STARTED);
  assert.ok(types.includes(HarnessEventType.APPROVAL_REQUESTED));
  assert.ok(types.includes(HarnessEventType.APPROVAL_RESOLVED));
  assert.ok(types.includes(HarnessEventType.TOOL_STARTED));
  assert.ok(types.includes(HarnessEventType.TOOL_COMPLETED));
  assert.equal(types.at(-1), HarnessEventType.RUN_COMPLETED);
  assert.ok(events.every((event) => event.runId === runId || event.runId === null));
  assert.deepEqual(
    events.map((event) => event.seq),
    [...events.map((event) => event.seq)].sort((left, right) => left - right),
  );
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
  assert.equal(runtime.isRunning, false);
  assert.equal(runtime.currentRunId, null);
  assert.equal(runtime.lastSeq, events.at(-1)?.seq);
});

test("runtime aborts an in-flight run and leaves no active run", async () => {
  const events: HarnessEvent[] = [];
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = new AgentRuntime({
    autoApprove: () => true,
    maxTokens: 1024,
    model: "test-model",
    modelClient: new HangingModel(),
    sessionId: "session-2",
    sink: (event) => {
      events.push(event);
      if (event.type === HarnessEventType.RUN_STARTED) started?.();
    },
    systemPrompt: "test",
    tools: new ToolRegistry(),
    workspaceRoot: process.cwd(),
  });

  const { done, runId } = runtime.startRun("等一会儿");
  await startedPromise;
  assert.equal(runtime.abort(runId), true);
  await done;
  assert.equal(events.at(-1)?.type, HarnessEventType.RUN_ABORTED);
  assert.equal(runtime.isRunning, false);
});
