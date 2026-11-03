import type { Tool, ToolResult } from "@harness/core";
import { z } from "zod";
import type { BackgroundCommandService } from "./background-command-service";

const startSchema = z.object({
  command: z.string().min(1).max(65_536).describe("在 workspace 根目录后台执行的命令"),
  name: z.string().min(1).max(80).optional().describe("便于识别的名称"),
});

const readSchema = z.object({
  id: z.string().min(1).max(100),
});

const waitSchema = z.object({
  id: z.string().min(1).max(100),
  timeoutSeconds: z.number().int().min(1).max(120).default(30),
});

export function createBackgroundCommandTools(
  service: BackgroundCommandService,
  sessionId: string,
  workspaceRoot: string,
): Tool[] {
  return [
    startTool(service, sessionId, workspaceRoot),
    listTool(service, sessionId),
    readTool(service, sessionId),
    waitTool(service, sessionId),
    stopTool(service, sessionId),
  ];
}

function startTool(
  service: BackgroundCommandService,
  sessionId: string,
  workspaceRoot: string,
): Tool {
  return {
    description:
      "在 workspace 中启动一个后台命令，适合 dev server、watch、长时间测试等。启动前需要用户审批；命令不会阻塞 Agent。",
    async execute(input): Promise<ToolResult> {
      const parsed = startSchema.parse(input);
      const command = service.start({ ...parsed, sessionId, workspaceRoot });
      return {
        content: `已启动后台命令 ${command.id}（${command.name}）。运行状态：${command.status}。`,
      };
    },
    inputSchema: toJsonSchema(startSchema),
    name: "start_background_command",
    parse: (input) => startSchema.parse(input),
    requiresApproval: true,
    summarize: (input) => {
      const parsed = startSchema.parse(input);
      return `后台执行：${parsed.command}`;
    },
  };
}

function listTool(service: BackgroundCommandService, sessionId: string): Tool {
  return {
    description: "列出当前 Session 的后台命令及状态。",
    async execute(): Promise<ToolResult> {
      const commands = service.list(sessionId);
      if (commands.length === 0) return { content: "当前没有后台命令。" };
      return {
        content: commands
          .map(
            (command) =>
              `${command.id} [${command.status}] ${command.name}\n  $ ${command.command}`,
          )
          .join("\n"),
      };
    },
    inputSchema: { properties: {}, type: "object" },
    name: "list_background_commands",
    parse: (input) => input,
    requiresApproval: false,
    summarize: () => "列出后台命令",
  };
}

function readTool(service: BackgroundCommandService, sessionId: string): Tool {
  return {
    description: "读取一个后台命令的 stdout、stderr 与退出状态。",
    async execute(input): Promise<ToolResult> {
      const parsed = readSchema.parse(input);
      const command = service.get(sessionId, parsed.id);
      return {
        content: [
          `$ ${command.command}`,
          `[${command.status}${command.exitCode === null ? "" : ` · exit ${command.exitCode}`}]`,
          command.stdout === "" ? "" : `[stdout]\n${command.stdout}`,
          command.stderr === "" ? "" : `[stderr]\n${command.stderr}`,
        ]
          .filter((part) => part !== "")
          .join("\n"),
      };
    },
    inputSchema: toJsonSchema(readSchema),
    name: "read_background_command",
    parse: (input) => readSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `读取后台输出 ${readSchema.parse(input).id}`,
  };
}

function waitTool(service: BackgroundCommandService, sessionId: string): Tool {
  return {
    description:
      "等待一个后台命令结束，最多等待 120 秒；结束或超时后返回状态与最近输出，便于继续读取完整结果。",
    async execute(input, context): Promise<ToolResult> {
      const parsed = waitSchema.parse(input);
      const deadline = Date.now() + parsed.timeoutSeconds * 1_000;
      for (;;) {
        context.signal.throwIfAborted();
        const command = service.get(sessionId, parsed.id);
        if (command.status !== "running") {
          return {
            content: [
              `后台命令 ${command.id} 已结束：${command.status}${command.exitCode === null ? "" : ` · exit ${command.exitCode}`}`,
              command.stdout === "" ? "" : `[stdout]\n${command.stdout.slice(-8_000)}`,
              command.stderr === "" ? "" : `[stderr]\n${command.stderr.slice(-8_000)}`,
            ]
              .filter((part) => part !== "")
              .join("\n"),
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            content: `等待超时（${parsed.timeoutSeconds}s），后台命令 ${command.id} 仍在运行。最近输出：\n${command.stdout.slice(-4_000)}`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
      }
    },
    inputSchema: toJsonSchema(waitSchema),
    name: "wait_background_command",
    parse: (input) => waitSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `等待后台命令 ${waitSchema.parse(input).id}`,
  };
}

function stopTool(service: BackgroundCommandService, sessionId: string): Tool {
  return {
    description: "停止一个仍在运行的后台命令，并清理进程树。",
    async execute(input): Promise<ToolResult> {
      const parsed = readSchema.parse(input);
      const command = service.stop(sessionId, parsed.id);
      return { content: `后台命令 ${command.id} 状态：${command.status}。` };
    },
    inputSchema: toJsonSchema(readSchema),
    name: "stop_background_command",
    parse: (input) => readSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `停止后台命令 ${readSchema.parse(input).id}`,
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
