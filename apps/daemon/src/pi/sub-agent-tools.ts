import type { Tool, ToolResult } from "@harness/core";
import { z } from "zod";
import type { SubAgentOrchestrator, SubAgentResult } from "./sub-agent-orchestrator";

const agentTypeSchema = z.enum(["explorer", "worker", "reviewer"]);

const spawnSchema = z.object({
  agentType: agentTypeSchema
    .optional()
    .describe("explorer 只读调研；worker 可写；reviewer 只读审查，默认 worker"),
  dependsOn: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe("前置子 Agent 的 executionId；全部完成后才会启动"),
  name: z.string().min(1).max(80).optional().describe("用于展示的子 Agent 名称"),
  task: z.string().min(1).max(20_000).describe("交给子 Agent 的完整、自包含任务"),
});

const workflowNodeSchema = z.object({
  agentType: agentTypeSchema.optional(),
  dependsOn: z.array(z.string().min(1).max(50)).max(8).optional(),
  id: z.string().min(1).max(50).describe("节点 id，供 dependsOn 引用"),
  task: z.string().min(1).max(20_000),
  title: z.string().min(1).max(120).optional(),
});

const workflowSchema = z.object({
  nodes: z.array(workflowNodeSchema).min(1).max(12),
});

const waitSchema = z.object({
  executionIds: z.array(z.string().min(1)).max(8).optional(),
  mode: z.enum(["all", "any"]).optional().describe("等待全部还是任意一个，默认 all"),
  timeoutSeconds: z.number().int().min(1).max(900).optional().describe("最长等待秒数，默认 300"),
});

const sendSchema = z.object({
  executionId: z.string().min(1),
  message: z.string().min(1).max(10_000),
});

const stopSchema = z.object({ executionId: z.string().min(1) });

export function createSubAgentTools(orchestrator: SubAgentOrchestrator): Tool[] {
  return [
    {
      description:
        "启动一个独立子 Agent 并行处理任务。子 Agent 有独立上下文，可调研、实现或审查；启动后用 wait_agents 等待结果。",
      async execute(input): Promise<ToolResult> {
        const parsed = spawnSchema.parse(input);
        const { executionId, name } = await orchestrator.spawn(parsed);
        return {
          content: `已启动子 Agent ${name}（${executionId}）。使用 wait_agents 等待其完成并读取结果。`,
        };
      },
      inputSchema: toJsonSchema(spawnSchema),
      name: "spawn_agent",
      parse: (input) => spawnSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => {
        const parsed = spawnSchema.parse(input);
        return `启动子 Agent（${parsed.agentType ?? "worker"}）：${parsed.task.slice(0, 80)}`;
      },
    },
    {
      description:
        "一次提交一个任务依赖图（DAG）。节点用 id 标识，dependsOn 引用前置节点；依赖完成后自动调度，失败会向依赖它的节点传播。",
      async execute(input): Promise<ToolResult> {
        const parsed = workflowSchema.parse(input);
        const results = await orchestrator.runDag(parsed.nodes);
        return {
          content: [
            `已启动工作流（${results.length} 个节点）：`,
            ...results.map(
              (result) => `- ${result.nodeId} → ${result.executionId}（${result.name}）`,
            ),
            "",
            "使用 wait_agents 等待所需节点完成。",
          ].join("\n"),
        };
      },
      inputSchema: toJsonSchema(workflowSchema),
      name: "run_workflow",
      parse: (input) => workflowSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => {
        const parsed = workflowSchema.parse(input);
        return `运行工作流（${parsed.nodes.length} 个节点）`;
      },
    },
    {
      description:
        "等待一个或多个子 Agent 完成。返回每个子 Agent 的状态、结果摘要或错误；超时后返回当前状态。",
      async execute(input, context): Promise<ToolResult> {
        const parsed = waitSchema.parse(input);
        const results = await orchestrator.wait(
          parsed.executionIds ?? [],
          parsed.mode ?? "all",
          parsed.timeoutSeconds ?? 300,
          context.signal,
        );
        return { content: formatResults(results) };
      },
      inputSchema: toJsonSchema(waitSchema),
      name: "wait_agents",
      parse: (input) => waitSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => {
        const parsed = waitSchema.parse(input);
        return `等待 ${parsed.executionIds?.length ?? "全部"} 个子 Agent`;
      },
    },
    {
      description: "向仍在运行的子 Agent 追加消息；子 Agent 会把它作为后续输入继续工作。",
      async execute(input): Promise<ToolResult> {
        const parsed = sendSchema.parse(input);
        const disposition = await orchestrator.send(parsed.executionId, parsed.message);
        return {
          content:
            disposition === "queued"
              ? "消息已排队，子 Agent 会在当前回答后处理。"
              : "消息已发送给子 Agent。",
        };
      },
      inputSchema: toJsonSchema(sendSchema),
      name: "send_agent",
      parse: (input) => sendSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => `向子 Agent ${sendSchema.parse(input).executionId} 发送消息`,
    },
    {
      description: "停止一个仍在运行的子 Agent。",
      async execute(input): Promise<ToolResult> {
        const parsed = stopSchema.parse(input);
        const stopped = await orchestrator.stop(parsed.executionId);
        return { content: stopped ? "子 Agent 已停止。" : "子 Agent 不存在或已经结束。" };
      },
      inputSchema: toJsonSchema(stopSchema),
      name: "stop_agent",
      parse: (input) => stopSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => `停止子 Agent ${stopSchema.parse(input).executionId}`,
    },
  ];
}

function formatResults(results: readonly SubAgentResult[]): string {
  if (results.length === 0) return "没有匹配的子 Agent。";
  return results
    .map((result) => {
      const lines = [`- ${result.name} [${result.status}] ${result.executionId}`];
      if (result.errorCode !== undefined) lines.push(`  错误：${result.errorCode}`);
      if (result.resultSummary !== undefined) {
        lines.push(`  ${result.resultSummary.slice(0, 2_000)}`);
      }
      if (result.usage !== undefined) {
        lines.push(`  tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
