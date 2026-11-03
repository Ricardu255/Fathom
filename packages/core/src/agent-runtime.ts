import { COMPACTION_SYSTEM_PROMPT } from "./compaction-prompt";
import { isModelClientError, type ModelClientError } from "./errors";
import { type HarnessEventSink, SessionEventEmitter } from "./event-queue";
import {
  type ApprovalResolvedData,
  type CompactionStartedData,
  type ContextCompactedData,
  type FileChangedData,
  HarnessEventType,
  type MessageCompletedData,
  type ModelRetryData,
  type RunCompletedData,
  type RunFailedData,
  type RunStartedData,
  type TextDeltaData,
  type TodoItem,
  type TodosUpdatedData,
  type ToolCompletedData,
  type ToolFailedData,
  type ToolStartedData,
  type UsageData,
} from "./events";
import type { KnowledgeSearch } from "./knowledge";
import {
  type AgentMessage,
  cloneMessages,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  isToolResultOnlyMessage,
  sanitizeToolPairing,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./messages";
import type { ModelClient, ModelRequest, ModelResult } from "./provider";
import { randomUUID } from "./random-uuid";
import type { Tool, ToolRegistry } from "./tool";

export interface AgentRuntimeOptions {
  autoApprove?: () => boolean;
  compactionKeepMessages?: number;
  contextTokenLimit?: number;
  initialMessages?: readonly AgentMessage[];
  initialSeq?: number;
  initialTodos?: readonly TodoItem[];
  maxSteps?: number;
  maxTokens: number;
  model: string;
  modelClient: ModelClient;
  protectedPaths?: readonly string[];
  searchKnowledge?: KnowledgeSearch;
  sessionId: string;
  sink: HarnessEventSink;
  systemPrompt: string;
  tools: ToolRegistry;
  workspaceRoot: string;
}

export interface QueuedInput {
  createdAt: number;
  id: string;
  text: string;
}

interface ActiveRun {
  abort: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
  runId: string;
}

const DEFAULT_MAX_STEPS = 32;
const DEFAULT_CONTEXT_TOKEN_LIMIT = 120_000;
const DEFAULT_COMPACTION_KEEP_MESSAGES = 8;
const MAX_RETRIES = 2;
const COMPACTION_TRANSCRIPT_CHARS = 60_000;
const COMPACTION_INPUT_RATIO = 0.75;

/** 单个 Session 的 Agent 运行器：唯一持有消息历史、事件序号、审批与排队输入。 */
export class AgentRuntime {
  private readonly autoApprove: () => boolean;
  private readonly compactionKeepMessages: number;
  private readonly contextTokenLimit: number;
  private readonly maxSteps: number;
  private readonly maxTokens: number;
  private readonly model: string;
  private readonly modelClient: ModelClient;
  private readonly protectedPaths: readonly string[] | undefined;
  private readonly searchKnowledge: KnowledgeSearch | undefined;
  private readonly sessionId: string;
  private readonly sink: HarnessEventSink;
  private readonly systemPrompt: string;
  private readonly tools: ToolRegistry;
  private readonly workspaceRoot: string;

  private active: ActiveRun | null = null;
  private deltaChain: Promise<void> = Promise.resolve();
  private emitter: SessionEventEmitter;
  private messages: AgentMessage[];
  private queued: QueuedInput[] = [];
  private todos: TodoItem[];

  public constructor(options: AgentRuntimeOptions) {
    this.autoApprove = options.autoApprove ?? (() => false);
    this.compactionKeepMessages =
      options.compactionKeepMessages ?? DEFAULT_COMPACTION_KEEP_MESSAGES;
    this.contextTokenLimit = options.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxTokens = options.maxTokens;
    this.model = options.model;
    this.modelClient = options.modelClient;
    this.messages = cloneMessages(options.initialMessages ?? []);
    this.protectedPaths = options.protectedPaths;
    this.searchKnowledge = options.searchKnowledge;
    this.sessionId = options.sessionId;
    this.sink = options.sink;
    this.systemPrompt = options.systemPrompt;
    this.todos = [...(options.initialTodos ?? [])];
    this.tools = options.tools;
    this.workspaceRoot = options.workspaceRoot;
    this.emitter = new SessionEventEmitter(options.sessionId, options.initialSeq ?? 0, this.sink);
  }

  public get history(): AgentMessage[] {
    return cloneMessages(this.messages);
  }

  public get isRunning(): boolean {
    return this.active !== null;
  }

  public get lastSeq(): number {
    return this.emitter.lastSeq;
  }

  public get currentRunId(): string | null {
    return this.active?.runId ?? null;
  }

  public get queuedInputs(): QueuedInput[] {
    return this.queued.map((item) => ({ ...item }));
  }

  public get todoList(): TodoItem[] {
    return this.todos.map((item) => ({ ...item }));
  }

  public restore(messages: readonly AgentMessage[], lastSeq: number): void {
    if (this.active !== null) throw new Error("运行中的 Session 不能恢复历史");
    this.messages = cloneMessages(messages);
    this.emitter = new SessionEventEmitter(this.sessionId, lastSeq, this.sink);
  }

  public startRun(text: string): { done: Promise<void>; runId: string } {
    if (this.active !== null) throw new Error("SESSION_BUSY: 当前 Session 已有运行中的任务");
    const prompt = text.trim();
    if (!prompt) throw new Error("消息不能为空");
    const runId = randomUUID();
    const abort = new AbortController();
    this.active = { abort, approvals: new Map(), runId };
    const done = this.executeRun(runId, prompt, abort.signal).finally(() => {
      if (this.active?.runId === runId) this.active = null;
    });
    return { done, runId };
  }

  /** 运行中排队一条后续用户消息；Run 最终回答后自动接着执行。 */
  public enqueueInput(text: string): QueuedInput {
    if (this.active === null) throw new Error("SESSION_IDLE: 当前没有运行中的任务");
    const prompt = text.trim();
    if (!prompt) throw new Error("消息不能为空");
    if (prompt.length > 100_000) throw new Error("消息过长");
    const item: QueuedInput = { createdAt: Date.now(), id: randomUUID(), text: prompt };
    this.queued.push(item);
    return { ...item };
  }

  public removeQueuedInput(id: string): boolean {
    const index = this.queued.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.queued.splice(index, 1);
    return true;
  }

  public abort(runId: string): boolean {
    if (this.active?.runId !== runId) return false;
    this.active.abort.abort();
    for (const resolve of this.active.approvals.values()) resolve(false);
    this.active.approvals.clear();
    this.queued = [];
    return true;
  }

  public resolveApproval(approvalId: string, approved: boolean): boolean {
    const resolve = this.active?.approvals.get(approvalId);
    if (resolve === undefined) return false;
    this.active?.approvals.delete(approvalId);
    resolve(approved);
    return true;
  }

  private async executeRun(runId: string, prompt: string, signal: AbortSignal): Promise<void> {
    let steps = 0;
    try {
      await this.emitter.emit<RunStartedData>({
        data: { model: this.model, tools: this.tools.names() },
        runId,
        type: HarnessEventType.RUN_STARTED,
      });

      const userMessage = createUserMessage(prompt);
      this.messages.push(userMessage);
      await this.emitter.emit<MessageCompletedData>({
        data: { message: userMessage },
        runId,
        type: HarnessEventType.MESSAGE_COMPLETED,
      });

      for (;;) {
        if (signal.aborted) break;
        if (steps >= this.maxSteps) {
          throw new Error(`超过单轮最大步数限制（${this.maxSteps}）`);
        }
        steps += 1;

        await this.maybeCompact(runId, signal);
        this.deltaChain = Promise.resolve();
        const result = await this.streamWithRetry(
          runId,
          {
            maxTokens: this.maxTokens,
            messages: sanitizeToolPairing(this.messages),
            model: this.model,
            signal,
            system: this.buildSystemPrompt(),
            tools: this.tools.definitions(),
          },
          (text) => this.queueDelta(runId, text),
        );
        await this.deltaChain;

        const assistantMessage = createAssistantMessage(result.content);
        this.messages.push(assistantMessage);
        await this.emitter.emit<MessageCompletedData>({
          data: { message: assistantMessage },
          runId,
          type: HarnessEventType.MESSAGE_COMPLETED,
        });

        if (result.usage !== undefined) {
          await this.emitter.emit<UsageData>({
            data: { model: this.model, ...result.usage },
            runId,
            type: HarnessEventType.USAGE,
          });
        }

        const toolUses = result.content.filter(
          (block): block is ToolUseBlock => block.type === "tool_use",
        );
        if (toolUses.length === 0 || result.stopReason !== "tool_use") {
          const next = this.queued.shift();
          if (next !== undefined) {
            const queuedMessage = createUserMessage(next.text);
            this.messages.push(queuedMessage);
            await this.emitter.emit<MessageCompletedData>({
              data: { message: queuedMessage, queuedInputId: next.id },
              runId,
              type: HarnessEventType.MESSAGE_COMPLETED,
            });
            continue;
          }
          break;
        }

        const toolResults: ToolResultBlock[] = [];
        for (const toolUse of toolUses) {
          if (signal.aborted) break;
          toolResults.push(await this.executeTool(runId, toolUse, signal));
        }
        if (signal.aborted) break;

        const toolMessage = createToolResultMessage(toolResults);
        this.messages.push(toolMessage);
        await this.emitter.emit<MessageCompletedData>({
          data: { hidden: true, message: toolMessage },
          runId,
          type: HarnessEventType.MESSAGE_COMPLETED,
        });
      }

      if (signal.aborted) {
        await this.emitter.emit({ data: null, runId, type: HarnessEventType.RUN_ABORTED });
        return;
      }
      await this.emitter.emit<RunCompletedData>({
        data: { steps },
        runId,
        type: HarnessEventType.RUN_COMPLETED,
      });
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) {
        await this.safeEmit({ data: null, runId, type: HarnessEventType.RUN_ABORTED });
        return;
      }
      const code = isModelClientError(error) ? error.code : "UNKNOWN";
      await this.safeEmit<RunFailedData>({
        data: { code, message: errorMessage(error) },
        runId,
        type: HarnessEventType.RUN_FAILED,
      });
    } finally {
      for (const resolve of this.active?.approvals.values() ?? []) resolve(false);
      this.active?.approvals.clear();
      this.queued = [];
    }
  }

  private async executeTool(
    runId: string,
    toolUse: ToolUseBlock,
    signal: AbortSignal,
  ): Promise<ToolResultBlock> {
    await this.emitter.emit<ToolStartedData>({
      data: { input: toolUse.input, toolCallId: toolUse.id, toolName: toolUse.name },
      runId,
      type: HarnessEventType.TOOL_STARTED,
    });

    const tool = this.tools.get(toolUse.name);
    if (tool === undefined) {
      return this.failTool(runId, toolUse, `未知工具: ${toolUse.name}`);
    }

    let parsed: unknown;
    try {
      parsed = tool.parse(toolUse.input);
    } catch (error: unknown) {
      return this.failTool(runId, toolUse, `工具参数无效: ${errorMessage(error)}`);
    }

    if (tool.requiresApproval && !this.autoApprove()) {
      const approved = await this.requestApproval(runId, toolUse, tool, signal);
      if (!approved) {
        return this.failTool(runId, toolUse, "用户拒绝了该工具调用");
      }
    }

    try {
      const result = await tool.execute(parsed, {
        ...(this.protectedPaths === undefined ? {} : { protectedPaths: this.protectedPaths }),
        ...(this.searchKnowledge === undefined ? {} : { searchKnowledge: this.searchKnowledge }),
        signal,
        workspaceRoot: this.workspaceRoot,
      });
      await this.emitter.emit<ToolCompletedData>({
        data: { result: result.content, toolCallId: toolUse.id, toolName: toolUse.name },
        runId,
        type: HarnessEventType.TOOL_COMPLETED,
      });
      for (const change of result.fileChanges ?? []) {
        await this.emitter.emit<FileChangedData>({
          data: { ...change, toolCallId: toolUse.id, toolName: toolUse.name },
          runId,
          type: HarnessEventType.FILE_CHANGED,
        });
      }
      if (result.todos !== undefined) {
        this.todos = [...result.todos];
        await this.emitter.emit<TodosUpdatedData>({
          data: { todos: this.todos },
          runId,
          type: HarnessEventType.TODOS_UPDATED,
        });
      }
      return {
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
        toolUseId: toolUse.id,
        type: "tool_result",
      };
    } catch (error: unknown) {
      return this.failTool(runId, toolUse, errorMessage(error));
    }
  }

  private async failTool(
    runId: string,
    toolUse: ToolUseBlock,
    message: string,
  ): Promise<ToolResultBlock> {
    await this.safeEmit<ToolFailedData>({
      data: { error: message, toolCallId: toolUse.id, toolName: toolUse.name },
      runId,
      type: HarnessEventType.TOOL_FAILED,
    });
    return {
      content: message,
      isError: true,
      toolUseId: toolUse.id,
      type: "tool_result",
    };
  }

  private async requestApproval(
    runId: string,
    toolUse: ToolUseBlock,
    tool: Tool,
    signal: AbortSignal,
  ): Promise<boolean> {
    const active = this.active;
    if (active === null || signal.aborted) return false;
    const approvalId = randomUUID();
    let resolveDecision: (approved: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
      active.approvals.set(approvalId, resolve);
    });
    const onAbort = () => {
      active.approvals.delete(approvalId);
      resolveDecision(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // 中止可能发生在 TOOL_STARTED emit 的 await 窗口，此时监听器不会再触发。
    if (signal.aborted) onAbort();

    let summary = tool.name;
    try {
      summary = tool.summarize(tool.parse(toolUse.input));
    } catch {
      // 参数无效时仍允许用户看到原始输入并拒绝。
    }

    try {
      await this.emitter.emit({
        data: {
          approvalId,
          input: toolUse.input,
          summary,
          toolCallId: toolUse.id,
          toolName: toolUse.name,
        },
        runId,
        type: HarnessEventType.APPROVAL_REQUESTED,
      });
      const approved = await decision;
      await this.safeEmit<ApprovalResolvedData>({
        data: { approvalId, decision: approved ? "approved" : "denied" },
        runId,
        type: HarnessEventType.APPROVAL_RESOLVED,
      });
      return approved;
    } finally {
      signal.removeEventListener("abort", onAbort);
      active.approvals.delete(approvalId);
    }
  }

  private buildSystemPrompt(): string {
    if (this.todos.length === 0) return this.systemPrompt;
    const list = this.todos
      .map((item) => `- [${item.status}] ${item.id}: ${item.content}`)
      .join("\n");
    return `${this.systemPrompt}\n\n当前任务清单（由 update_todos 维护）：\n${list}`;
  }

  private async maybeCompact(runId: string, signal: AbortSignal): Promise<void> {
    const definitions = this.tools.definitions();
    const beforeTokens = estimateContextTokens(this.messages, this.systemPrompt, definitions);
    if (
      beforeTokens <= this.contextTokenLimit * COMPACTION_INPUT_RATIO ||
      this.messages.length <= this.compactionKeepMessages + 2
    ) {
      return;
    }

    let cutoff = Math.max(1, this.messages.length - this.compactionKeepMessages);
    while (cutoff > 0) {
      const candidate = this.messages[cutoff];
      if (candidate?.role === "user" && !isToolResultOnlyMessage(candidate)) break;
      cutoff -= 1;
    }
    if (cutoff <= 0) return;

    const older = this.messages.slice(0, cutoff);
    const recent = sanitizeToolPairing(this.messages.slice(cutoff));
    if (older.length === 0 || recent.length === 0) return;

    await this.safeEmit<CompactionStartedData>({
      data: { estimatedTokens: beforeTokens, limit: this.contextTokenLimit },
      runId,
      type: HarnessEventType.CONTEXT_COMPACTION_STARTED,
    });

    let summary: string;
    try {
      summary = await this.summarize(older, runId, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      await this.safeEmit<ContextCompactedData>({
        data: {
          afterTokens: beforeTokens,
          beforeTokens,
          replacedMessages: 0,
          summary: "",
        },
        runId,
        type: HarnessEventType.CONTEXT_COMPACTED,
      });
      return;
    }
    if (summary.trim() === "") return;

    const summaryMessage = createUserMessage(`[早期对话摘要]\n${summary.trim()}`);
    this.messages = [summaryMessage, ...recent];
    const afterTokens = estimateContextTokens(this.messages, this.systemPrompt, definitions);
    await this.safeEmit<ContextCompactedData>({
      data: {
        afterTokens,
        beforeTokens,
        replacedMessages: older.length,
        summary: summary.trim(),
      },
      runId,
      type: HarnessEventType.CONTEXT_COMPACTED,
    });
  }

  private async summarize(
    messages: readonly AgentMessage[],
    runId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const transcript = messages
      .map(
        (message) => `${message.role === "user" ? "用户" : "助手"}：${serializeMessage(message)}`,
      )
      .join("\n\n");
    const clipped =
      transcript.length > COMPACTION_TRANSCRIPT_CHARS
        ? transcript.slice(transcript.length - COMPACTION_TRANSCRIPT_CHARS)
        : transcript;
    const result = await this.streamWithRetry(
      runId,
      {
        maxTokens: 2_000,
        messages: [createUserMessage(`请压缩下面的对话历史：\n\n${clipped}`)],
        model: this.model,
        signal,
        system: COMPACTION_SYSTEM_PROMPT,
        tools: [],
      },
      () => undefined,
    );
    return result.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  }

  private async streamWithRetry(
    runId: string,
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    let emittedText = false;
    const track = (text: string) => {
      if (!text) return;
      emittedText = true;
      onTextDelta(text);
    };

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.modelClient.stream(request, track);
      } catch (error: unknown) {
        if (request.signal.aborted || isAbortError(error)) throw error;
        const modelError: ModelClientError | undefined = isModelClientError(error)
          ? error
          : undefined;
        if (
          modelError === undefined ||
          !modelError.retryable ||
          emittedText ||
          attempt >= MAX_RETRIES
        ) {
          throw modelError ?? error;
        }
        await this.safeEmit<ModelRetryData>({
          data: {
            attempt: attempt + 1,
            code: modelError.code,
            message: modelError.message,
          },
          runId,
          type: HarnessEventType.MODEL_RETRY,
        });
        await abortableDelay(500 * 2 ** attempt, request.signal);
      }
    }
  }

  private queueDelta(runId: string, text: string): void {
    if (!text) return;
    this.deltaChain = this.deltaChain.then(() =>
      this.emitter
        .emit<TextDeltaData>({
          data: { text },
          runId,
          type: HarnessEventType.TEXT_DELTA,
        })
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  }

  /** 终止事件失败不应掩盖原始错误；失败会由 daemon 记录。 */
  private async safeEmit<T>(draft: {
    data: T;
    runId: string;
    type: (typeof HarnessEventType)[keyof typeof HarnessEventType];
  }): Promise<void> {
    try {
      await this.emitter.emit(draft);
    } catch {
      // 忽略：事件持久化失败时 daemon 的 sink 会记录日志。
    }
  }
}

export function estimateContextTokens(
  messages: readonly AgentMessage[],
  systemPrompt: string,
  tools: readonly { description: string; inputSchema: Record<string, unknown>; name: string }[],
): number {
  const characters = JSON.stringify({ messages, systemPrompt, tools }).length;
  return Math.ceil(characters / 3.5);
}

function serializeMessage(message: AgentMessage): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") {
        return `[调用工具 ${block.name}：${JSON.stringify(block.input).slice(0, 1_000)}]`;
      }
      if (block.type === "image") return "[图片]";
      if (block.type === "thinking") return `[思考：${block.text.slice(0, 2_000)}]`;
      return `[工具结果：${block.content.slice(0, 2_000)}]`;
    })
    .join("\n");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Request was aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"))
  );
}
