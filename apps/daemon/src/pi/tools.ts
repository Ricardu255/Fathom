import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { KnowledgeSearch, Tool, ToolAnnotations, ToolResult } from "@harness/core";
import { assessCommand, resolveWorkspacePath, suggestCommandPrefix } from "@harness/policy";
import type { TSchema } from "typebox";
import type { ToolExecutionGuard } from "./tool-guard";
import {
  assertObservedUnchanged,
  type WorkspaceWriteCoordinator,
} from "./workspace-write-coordinator";

export interface PiToolApprovalInput {
  consequence?: string;
  executionId?: string;
  input: unknown;
  prefixRule?: string;
  risk?: "high" | "normal";
  summary: string;
  target?: string;
  toolCallId: string;
  toolName: string;
}

export interface PiToolHooks {
  blockedToolReason?: (toolName: string) => string | undefined;
  guard?: ToolExecutionGuard;
  isCommandAllowed?: (command: string) => boolean;
  onResult(input: {
    result: ToolResult;
    toolCallId: string;
    toolName: string;
  }): Promise<void> | void;
  protectedPaths?: readonly string[];
  requestApproval(
    input: PiToolApprovalInput,
    signal: AbortSignal | undefined,
    options?: { force?: boolean },
  ): Promise<boolean>;
  sandboxBlockedReason?: (toolName: string, input: unknown) => string | undefined;
  searchKnowledge?: KnowledgeSearch;
  workspaceRoot: string;
  writeCoordinator?: WorkspaceWriteCoordinator;
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * 只读工具可以并行；pi 只要发现同一批里有一个 sequential 工具，就会把整批串行。
 * 因此写文件、命令、审批、子 Agent 与工作流工具必须留在 sequential，读操作才不会被误伤。
 */
const PARALLEL_SAFE_TOOLS = new Set([
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
]);

export function executionModeForTool(
  tool: Pick<Tool, "annotations" | "name">,
): "parallel" | "sequential" {
  // 声明为只读的工具可以并行；其余仍按白名单，避免新工具默认就并发。
  if (tool.annotations?.readOnly === true) return "parallel";
  return PARALLEL_SAFE_TOOLS.has(tool.name) ? "parallel" : "sequential";
}

/** 我们的 annotation 命名沿用 MCP 习惯，pi 侧要求带 Hint 后缀。 */
export function toPiAnnotations(
  annotations: ToolAnnotations | undefined,
): { destructiveHint?: boolean; idempotentHint?: boolean; readOnlyHint?: boolean } | undefined {
  if (annotations === undefined) return undefined;
  const mapped = {
    ...(annotations.destructive === undefined ? {} : { destructiveHint: annotations.destructive }),
    ...(annotations.idempotent === undefined ? {} : { idempotentHint: annotations.idempotent }),
    ...(annotations.readOnly === undefined ? {} : { readOnlyHint: annotations.readOnly }),
  };
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

/** 把我们的 Tool 契约包装成 pi 的 ToolDefinition，并在执行前插入审批。 */
export function toPiTools(tools: readonly Tool[], hooks: PiToolHooks): ToolDefinition[] {
  return tools.map((tool) => {
    const annotations = toPiAnnotations(tool.annotations);
    return {
      ...(annotations === undefined ? {} : { annotations }),
      description: tool.description,
      executionMode: executionModeForTool(tool),
      // JSON Schema 与 TypeBox 的 TSchema 结构兼容；运行时由 pi 再做一次参数校验。
      parameters: tool.inputSchema as unknown as TSchema,
      label: tool.name,
      name: tool.name,
      async execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
      ): Promise<AgentToolResult> {
        let parsed: unknown;
        try {
          parsed = tool.parse(params);
        } catch (error: unknown) {
          return errorResult(`工具参数无效: ${errorMessage(error)}`);
        }

        const blockedReason = hooks.blockedToolReason?.(tool.name);
        if (blockedReason !== undefined) return errorResult(blockedReason);

        const sandboxReason = hooks.sandboxBlockedReason?.(tool.name, parsed);
        let approvedByHost = false;
        if (sandboxReason !== undefined) {
          approvedByHost = await hooks.requestApproval(
            {
              ...describeApproval(tool.name, parsed),
              input: params,
              risk: "high",
              summary: `沙箱拒绝：${sandboxReason}。是否允许本次以宿主权限重跑？`,
              toolCallId,
              toolName: tool.name,
            },
            signal,
            { force: true },
          );
          if (!approvedByHost) return errorResult(sandboxReason);
        }

        const command =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).command === "string"
            ? ((parsed as Record<string, unknown>).command as string)
            : null;
        const prefixApproved =
          command !== null &&
          (tool.name === "run_command" || tool.name === "start_background_command") &&
          hooks.isCommandAllowed?.(command) === true;
        if (tool.requiresApproval && !prefixApproved && !approvedByHost) {
          let summary = tool.name;
          try {
            summary = tool.summarize(parsed);
          } catch {
            // 参数已经校验过，这里失败只影响展示。
          }
          const approved = await hooks.requestApproval(
            {
              ...describeApproval(tool.name, parsed),
              input: params,
              summary,
              toolCallId,
              toolName: tool.name,
            },
            signal,
          );
          if (!approved) return errorResult("用户拒绝了该工具调用。");
        }

        try {
          const runTool = (toolSignal: AbortSignal) =>
            tool.execute(parsed, {
              ...(hooks.protectedPaths === undefined
                ? {}
                : { protectedPaths: hooks.protectedPaths }),
              ...(hooks.searchKnowledge === undefined
                ? {}
                : { searchKnowledge: hooks.searchKnowledge }),
              signal: toolSignal,
              workspaceRoot: hooks.workspaceRoot,
            });
          const coordinator = hooks.writeCoordinator;
          const writePath =
            coordinator === undefined ? null : await resolveWritePath(tool.name, parsed, hooks);
          const runWithWriteGuard = async (toolSignal: AbortSignal): Promise<ToolResult> => {
            if (coordinator === undefined || writePath === null) {
              const result = await runTool(toolSignal);
              recordObservations(coordinator, result);
              return result;
            }
            return coordinator.withLock(writePath, toolSignal, async () => {
              await assertObservedUnchanged(coordinator, writePath);
              const result = await runTool(toolSignal);
              recordObservations(coordinator, result);
              return result;
            });
          };
          const result =
            hooks.guard === undefined
              ? await runWithWriteGuard(signal ?? NEVER_ABORTED)
              : await hooks.guard.run(tool.name, parsed, signal, runWithWriteGuard);
          await hooks.onResult({ result, toolCallId, toolName: tool.name });
          return {
            content: [
              { text: result.content, type: "text" },
              ...(result.images ?? []).map((image) => ({
                data: image.data,
                mimeType: image.mimeType,
                type: "image" as const,
              })),
            ],
            details: result as unknown as JsonValue,
            ...(result.isError === true ? { isError: true } : {}),
            ...(result.structuredContent === undefined
              ? {}
              : { structuredContent: result.structuredContent as JsonValue }),
          };
        } catch (error: unknown) {
          return errorResult(`工具执行失败: ${errorMessage(error)}`);
        }
      },
    };
  });
}

function recordObservations(
  coordinator: WorkspaceWriteCoordinator | undefined,
  result: ToolResult,
): void {
  if (coordinator === undefined) return;
  for (const file of result.observedFiles ?? []) {
    coordinator.observe(file.path, file.hash);
  }
}

async function resolveWritePath(
  toolName: string,
  parsed: unknown,
  hooks: PiToolHooks,
): Promise<string | null> {
  if (toolName !== "write_file" && toolName !== "edit_file") return null;
  const path =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { path?: unknown }).path === "string"
      ? (parsed as { path: string }).path
      : null;
  if (path === null) return null;
  try {
    return await resolveWorkspacePath({
      ...(toolName === "write_file" ? { allowMissing: true } : {}),
      ...(hooks.protectedPaths === undefined ? {} : { protectedPaths: hooks.protectedPaths }),
      path,
      workspaceRoot: hooks.workspaceRoot,
    });
  } catch {
    // 路径错误交给工具本身返回一致的错误信息。
    return null;
  }
}

function errorResult(message: string): AgentToolResult {
  return {
    content: [{ text: message, type: "text" }],
    details: { error: message },
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
export function describeApproval(
  toolName: string,
  input: unknown,
): Pick<PiToolApprovalInput, "consequence" | "prefixRule" | "risk" | "target"> {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  if (toolName === "run_command" || toolName === "start_background_command") {
    const command = typeof record.command === "string" ? record.command : "";
    const destructive = command !== "" && assessCommand(command).destructive;
    const prefixRule = suggestCommandPrefix(command);
    return {
      consequence: "命令可能修改工作区文件、运行进程或访问网络。",
      ...(prefixRule === null ? {} : { prefixRule }),
      risk: destructive ? "high" : "normal",
      target: command.slice(0, 180) || "Shell 命令",
    };
  }
  if (toolName === "write_file" || toolName === "edit_file") {
    const path = typeof record.path === "string" ? record.path : toolName;
    return {
      consequence: "将修改工作区文件。",
      risk: "normal",
      target: path,
    };
  }
  if (toolName.startsWith("save_memory") || toolName === "forget_memory") {
    return {
      consequence: "将修改本机长期记忆。",
      risk: "normal",
      target: toolName === "forget_memory" ? "删除记忆" : "长期记忆",
    };
  }
  return { risk: "normal", target: toolName };
}
