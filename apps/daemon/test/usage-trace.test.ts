import assert from "node:assert/strict";
import { test } from "node:test";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { projectTrace } from "../src/services/trace-service";
import { collectUsage } from "../src/services/usage-service";
import type { SessionRecord } from "../src/storage/database";

function event(
  type: HarnessEvent["type"],
  data: unknown,
  seq: number,
  timestamp = 1_000 + seq,
  runId: string | null = "run-1",
): HarnessEvent {
  return {
    data,
    id: `event-${seq}`,
    runId,
    seq,
    sessionId: "session-1",
    timestamp,
    type,
  };
}

const session = {
  id: "session-1",
  modelId: "model-a",
  providerId: "anthropic",
} as SessionRecord;

const pricing = (providerId: string, modelId: string) =>
  providerId === "anthropic" && modelId === "model-a" ? { input: 1, output: 2 } : null;

test("用量聚合主 Agent、子 Agent 与压缩次数", () => {
  const events = [
    event(HarnessEventType.USAGE, { inputTokens: 100, model: "model-a", outputTokens: 50 }, 1),
    event(
      HarnessEventType.SUBAGENT_STARTED,
      { agentType: "worker", executionId: "exec-1", modelId: "model-a", name: "w", task: "t" },
      2,
    ),
    event(
      HarnessEventType.SUBAGENT_COMPLETED,
      { executionId: "exec-1", usage: { inputTokens: 200, outputTokens: 100 } },
      3,
    ),
    event(HarnessEventType.CONTEXT_COMPACTED, { summary: "x" }, 4),
  ];
  const collected = collectUsage(events, session, pricing);
  assert.equal(collected.compactionCount, 1);
  assert.equal(collected.subAgentRuns, 1);
  assert.equal(collected.records.length, 2);
  assert.equal(collected.records[0]?.inputTokens, 100);
  assert.equal(collected.records[0]?.costUsd, (100 * 1 + 50 * 2) / 1_000_000);
  assert.equal(collected.records[1]?.source, "subagent");
  assert.equal(collected.records[1]?.modelId, "model-a");
});

test("Trace 投影 Run、Request、Tool、Approval、Compaction 与子 Agent", () => {
  const events = [
    event(HarnessEventType.RUN_STARTED, { model: "model-a", tools: ["read_file"] }, 1),
    event(
      HarnessEventType.REQUEST_SNAPSHOT,
      {
        estimatedInputTokens: 100,
        messages: [{ role: "user" }],
        model: "model-a",
        requestIndex: 1,
        systemPrompt: "system",
        tools: [{ name: "read_file" }],
      },
      2,
    ),
    event(HarnessEventType.USAGE, { inputTokens: 90, model: "model-a", outputTokens: 10 }, 3),
    event(
      HarnessEventType.TOOL_STARTED,
      { input: { path: "a.txt" }, toolCallId: "tool-1", toolName: "read_file" },
      4,
    ),
    event(
      HarnessEventType.TOOL_COMPLETED,
      { result: "ok", toolCallId: "tool-1", toolName: "read_file" },
      5,
    ),
    event(
      HarnessEventType.APPROVAL_REQUESTED,
      {
        approvalId: "approval-1",
        input: {},
        summary: "写入 a.txt",
        toolCallId: "tool-2",
        toolName: "write_file",
      },
      6,
    ),
    event(
      HarnessEventType.APPROVAL_RESOLVED,
      { approvalId: "approval-1", decision: "approved" },
      7,
    ),
    event(
      HarnessEventType.CONTEXT_COMPACTED,
      {
        afterTokens: 20,
        beforeTokens: 100,
        checkpointId: "cp-1",
        summary: "摘要",
        trigger: "manual",
      },
      8,
    ),
    event(
      HarnessEventType.SUBAGENT_STARTED,
      { agentType: "worker", executionId: "exec-1", modelId: "model-a", name: "w", task: "任务" },
      9,
    ),
    event(
      HarnessEventType.SUBAGENT_MESSAGE_COMPLETED,
      {
        executionId: "exec-1",
        message: { content: [{ text: "子结果", type: "text" }], role: "assistant" },
        parentExecutionId: null,
      },
      10,
    ),
    event(
      HarnessEventType.SUBAGENT_COMPLETED,
      { executionId: "exec-1", resultSummary: "完成", usage: { inputTokens: 5, outputTokens: 3 } },
      11,
    ),
    event(
      HarnessEventType.MESSAGE_COMPLETED,
      {
        hidden: true,
        message: { content: [{ text: "工具结果", type: "text" }], role: "user", timestamp: 1_900 },
      },
      11,
    ),
    event(
      HarnessEventType.MESSAGE_COMPLETED,
      {
        message: { content: [{ text: "用户输入", type: "text" }], role: "user", timestamp: 2_000 },
      },
      12,
    ),
    event(HarnessEventType.RUN_COMPLETED, { steps: 2 }, 13),
  ];
  const [run] = projectTrace(events);
  assert.ok(run !== undefined);
  assert.equal(run.status, "completed");
  assert.equal(run.steps, 2);
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0]?.inputTokens, 90);
  assert.equal(run.messages.length, 1);
  assert.equal(run.messages[0]?.role, "user");
  assert.equal(run.messages[0]?.text, "用户输入");
  assert.equal(run.tools[0]?.status, "completed");
  assert.equal(run.tools[0]?.result, "ok");
  assert.equal(run.approvals[0]?.decision, "approved");
  assert.equal(run.compactions[0]?.checkpointId, "cp-1");
  assert.equal(run.subAgents[0]?.status, "completed");
  assert.equal(run.subAgents[0]?.messages[0]?.text, "子结果");
  assert.equal(run.subAgents[0]?.usage?.inputTokens, 5);
});

test("Trace 处理失败与中止终态", () => {
  const failed = projectTrace([
    event(HarnessEventType.RUN_STARTED, { model: "m", tools: [] }, 1),
    event(HarnessEventType.RUN_FAILED, { code: "PROVIDER", message: "boom" }, 2),
  ]);
  assert.equal(failed[0]?.status, "failed");
  const aborted = projectTrace([
    event(HarnessEventType.RUN_STARTED, { model: "m", tools: [] }, 1),
    event(HarnessEventType.RUN_ABORTED, null, 2),
  ]);
  assert.equal(aborted[0]?.status, "aborted");
});
