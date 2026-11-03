import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "../config";
import { AUTO_FOLLOW_UP_MARKER } from "./auto-follow-up";

export interface PiModelSetup {
  mock: boolean;
  model: Model<Api>;
  modelId: string;
  modelRuntime: ModelRuntime;
  providerId: string;
}

export interface PiModelOverrides {
  apiKey?: string;
  mock?: boolean;
  model?: string;
  provider?: string;
}

/** 复用 pi 的 ModelRuntime/Provider 目录；Mock 模式仍使用同一模型元数据。 */
export async function createPiModelSetup(
  config: HarnessConfig,
  overrides: PiModelOverrides = {},
): Promise<PiModelSetup> {
  const providerId = overrides.provider ?? "anthropic";
  const modelId = overrides.model ?? config.model;
  const mock = overrides.mock ?? config.mockModel;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.piAgentDir, "auth.json"),
    modelsPath: null,
  });
  const model = modelRuntime.getModel(providerId, modelId);
  if (model === undefined) {
    const available = modelRuntime
      .getModels(providerId)
      .map((candidate) => candidate.id)
      .slice(0, 24)
      .join(", ");
    throw new Error(`未知模型 "${providerId}/${modelId}"。可用模型: ${available}`);
  }

  if (mock) {
    // 只为通过 SDK 的认证检查；实际调用被 faux stream 覆盖。
    await modelRuntime.setRuntimeApiKey(providerId, "mock-key");
  } else {
    const apiKey =
      overrides.apiKey ?? (providerId === "anthropic" ? config.anthropicApiKey : undefined);
    if (apiKey === undefined) {
      throw new Error(`使用 ${providerId} 的真实模型需要配置 API Key`);
    }
    await modelRuntime.setRuntimeApiKey(providerId, apiKey);
  }

  return { mock, model, modelId, modelRuntime, providerId };
}

/** 每个 Session 独立的 faux provider，避免并发会话互相消费脚本响应。 */
export function configureMockStream(session: AgentSession): void {
  const faux = fauxProvider({ tokensPerSecond: 80 });
  session.agent.streamFunction = ((model, context, options) => {
    faux.setResponses([(requestContext) => buildMockAssistant(requestContext)]);
    return faux.provider.streamSimple(model, context, options);
  }) as typeof session.agent.streamFunction;
}

function buildMockAssistant(context: TranscriptContext): AssistantMessage {
  const messages = context.messages;
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message))
    .join("\n");
  if (/summari[sz]e|compaction|compressed|摘要|压缩/iu.test(systemText)) {
    return fauxAssistantMessage(
      "（摘要）用户要求继续完成当前任务；此前已完成环境检查，保留了关键文件路径、待办和未验证假设。",
    );
  }

  const last = messages.at(-1);
  if (last?.role === "toolResult") {
    const resultText = textOf(last);
    if (resultText.includes("已启动工作流")) {
      const ids = [
        ...resultText.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu),
      ].map((match) => match[0]);
      if (ids.length > 0) {
        return fauxAssistantMessage([
          fauxToolCall("wait_agents", { executionIds: ids, mode: "all", timeoutSeconds: 120 }),
          fauxText("等待工作流节点完成。"),
        ]);
      }
    }
    if (resultText.includes("已启动子 Agent")) {
      const executionId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.exec(
        resultText,
      )?.[0];
      if (executionId !== undefined) {
        return fauxAssistantMessage([
          fauxToolCall("wait_agents", {
            executionIds: [executionId],
            mode: "all",
            timeoutSeconds: 60,
          }),
          fauxText("等待子 Agent 返回结果。"),
        ]);
      }
    }
    if (/^- .+\[(?:running|completed|failed|aborted)\]/mu.test(resultText)) {
      return fauxAssistantMessage(`子任务完成。\n\n${resultText.slice(0, 1_500)}`);
    }
    return fauxAssistantMessage(`工具执行完成。\n\n${resultText.slice(0, 1_500)}`);
  }

  // agent_before_settle 续轮不会注入新的用户消息；上一轮 assistant 的标记就是输入。
  if (last?.role === "assistant" && textOf(last).includes(AUTO_FOLLOW_UP_MARKER)) {
    return fauxAssistantMessage("续轮完成。");
  }

  const lastUserText = [...messages].reverse().find((message) => message.role === "user");
  const prompt = lastUserText === undefined ? "" : textOf(lastUserText);

  if (/(自动续轮|autonomous iteration|auto.?follow)/iu.test(prompt)) {
    return fauxAssistantMessage(`第一轮进行中。\n\n${AUTO_FOLLOW_UP_MARKER}`);
  }
  if (prompt.startsWith("Continue the autonomous task")) {
    return fauxAssistantMessage("续轮完成。");
  }
  if (/(工作流|workflow|DAG|依赖图)/iu.test(prompt)) {
    return fauxAssistantMessage([
      fauxToolCall("run_workflow", {
        nodes: [
          {
            agentType: "explorer",
            id: "research",
            task: "调研当前工作区结构并总结关键文件。",
            title: "调研工作区",
          },
          {
            agentType: "worker",
            dependsOn: ["research"],
            id: "implement",
            task: "实现一个简单的功能改进。",
            title: "实现改进",
          },
          {
            agentType: "explorer",
            dependsOn: ["research"],
            id: "docs",
            task: "整理当前项目的文档要点。",
            title: "整理文档",
          },
          {
            agentType: "reviewer",
            dependsOn: ["implement", "docs"],
            id: "review",
            task: "审查实现和文档的结果，指出风险。",
            title: "审查结果",
          },
        ],
      }),
      fauxText("我提交一个带依赖的工作流：调研 → 并行实现/文档 → 审查。"),
    ]);
  }
  if (/(子代理|子任务|并行|拆分|multi.?agent|spawn)/iu.test(prompt)) {
    const wantsWrite = /(写|创建|修改|write|edit)/iu.test(prompt);
    return fauxAssistantMessage([
      fauxToolCall("spawn_agent", {
        agentType: wantsWrite ? "worker" : "explorer",
        name: wantsWrite ? "worker" : "researcher",
        task: wantsWrite
          ? "帮我创建一个文件 mock-subagent.txt。"
          : "调研当前工作区结构并总结关键文件，不要修改任何文件。",
      }),
      fauxText(
        wantsWrite ? "我把写文件的任务交给子 Agent。" : "我把调研拆给一个子 Agent 并行处理。",
      ),
    ]);
  }
  if (/(列出|查看|检查|调研|list).{0,12}(文件|目录|files?|directories)/iu.test(prompt)) {
    return fauxAssistantMessage([
      fauxToolCall("list_files", { path: ".", depth: 3 }),
      fauxText("我先检查一下工作区结构。"),
    ]);
  }
  if (/(创建|写入|write).{0,12}(文件|file)/iu.test(prompt)) {
    return fauxAssistantMessage([
      fauxToolCall("write_file", {
        content: "Hello from the pi-backed mock agent.\n",
        path: "mock-demo.txt",
      }),
      fauxText("准备写入示例文件，需要你批准。"),
    ]);
  }
  if (/(检索|搜索|search).{0,12}(文献|知识库|knowledge)/iu.test(prompt)) {
    const rawQuery = /(?:检索|搜索|search)\s*[:：]?\s*(.{1,40})/iu.exec(prompt)?.[1];
    const query =
      rawQuery?.replace(/^(?:文献|知识库|knowledge)\s*[:：]?\s*/iu, "").trim() || "pipeline";
    return fauxAssistantMessage([
      fauxToolCall("search_knowledge", { limit: 5, query }),
      fauxText("我先在知识库里检索相关片段。"),
    ]);
  }
  if (/(待办|todo|任务清单)/iu.test(prompt)) {
    return fauxAssistantMessage([
      fauxToolCall("update_todos", {
        todos: [
          { content: "检查现有代码结构", status: "completed" },
          { content: "实现目标功能", status: "in_progress" },
          { content: "补充测试并运行", status: "pending" },
        ],
      }),
      fauxText("我先记录一份任务清单。"),
    ]);
  }

  return fauxAssistantMessage(
    [
      "## 尚未连接模型",
      "",
      "请打开 **设置 → 模型与 API**，选择 Provider、模型并填写 API Key。",
      "配置完成后发送消息，我会读写当前工作区，并在需要时请求你的批准。",
      "",
      `> 你刚才说：${prompt.slice(0, 300) || "（空消息）"}`,
    ].join("\n"),
  );
}

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}
