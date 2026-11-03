import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AttachmentContextData,
  type CheckpointRestoredData,
  type ContextCheckpoint,
  type ContextCompactedData,
  type HarnessEvent,
  HarnessEventType,
  type KnowledgeHit,
  type MessageImage,
  SessionEventEmitter,
  type ToolResult,
  type UserInputAnswer,
} from "@harness/core";
import { commandMatchesPrefix, validateCommandPrefix } from "@harness/policy";
import { sandboxBlockedNetworkReason, sandboxBlockedToolReason } from "@harness/sandbox";
import { createWorkspaceTools } from "@harness/tools";
import type { HarnessConfig } from "../config";
import type { MemoryService } from "../memory/memory-service";
import { createMemoryTools } from "../memory/memory-tools";
import { buildSystemPrompt } from "../prompts";
import type { BackgroundCommandService } from "../services/background-command-service";
import { createBackgroundCommandTools } from "../services/background-command-tools";
import {
  buildContextCheckpoint,
  collectCheckpoints,
  formatCheckpointForPrompt,
  latestUnconsumedRestore,
} from "../services/context-checkpoint";
import type { SessionEventBus } from "../services/event-bus";
import { SessionEventSink } from "../services/event-sink";
import { buildRequestSnapshot } from "../services/request-snapshot";
import type { WorkflowNodeSpec } from "../services/session-types";
import { SkillRegistry } from "../skills/skill-registry";
import { createSkillTools } from "../skills/skill-tools";
import type { HarnessDatabase, SessionRecord } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";
import { PiApprovalCoordinator } from "./approval";
import { buildApprovalReviewPrompt, parseApprovalReview } from "./approval-review";
import {
  AUTO_FOLLOW_UP_PROMPT,
  createAutoFollowUpExtension,
  requestsAutoFollowUp,
} from "./auto-follow-up";
import { createCommandSandboxRunner } from "./command-sandbox";
import { createReadDocumentTool, createViewPdfPageTool } from "./document-tools";
import { type PiBridgeEmit, PiEventBridge } from "./event-bridge";
import { configureMockStream, type PiModelSetup } from "./model";
import { createSessionHistoryTool } from "./session-history-tool";
import { SubAgentOrchestrator } from "./sub-agent-orchestrator";
import { createSubAgentTools } from "./sub-agent-tools";
import { ToolExecutionGuard } from "./tool-guard";
import { type PiToolApprovalInput, toPiTools } from "./tools";
import { UserInputCoordinator } from "./user-input-coordinator";
import { createUserInputTool } from "./user-input-tool";
import { loadAgentsContext } from "./workspace-context";
import { workspaceWriteCoordinator } from "./workspace-write-coordinator";

const PLAN_MODE_PREFIX =
  "【计划模式】当前只允许分析、阅读和调研，不要修改任何文件或执行命令。请输出清晰、可验收的执行计划；用户确认后会关闭计划模式再执行。";
const PLAN_BLOCKED_TOOLS = new Set([
  "edit_file",
  "forget_memory",
  "run_command",
  "run_workflow",
  "save_memory",
  "spawn_agent",
  "write_file",
]);

export interface MemoryRecall {
  context: string;
  hits: readonly KnowledgeHit[];
}

export interface AttachmentContext {
  attachments: AttachmentContextData["attachments"];
  context: string;
}

export interface QueuedInput {
  createdAt: number;
  id: string;
  images?: MessageImage[] | undefined;
  text: string;
}

export interface PiSessionEngineOptions {
  bus: SessionEventBus;
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  backgroundCommands?: BackgroundCommandService | undefined;
  logger: {
    error(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
  };
  memory?: MemoryService | undefined;
  modelSetup: PiModelSetup;
  session: SessionRecord;
}

/** 一个 Session 对应一个 pi AgentSession；事件投影到我们的 JSONL/SSE 协议。 */
export class PiSessionEngine {
  public readonly sessionId: string;
  private readonly config: HarnessConfig;
  private readonly database: HarnessDatabase;
  private readonly modelSetup: PiModelSetup;
  private readonly optionsMemory: MemoryService | undefined;
  private readonly sessionRecord: SessionRecord;
  private readonly approval: PiApprovalCoordinator;
  private readonly userInput: UserInputCoordinator;
  private readonly backgroundCommands: BackgroundCommandService | undefined;
  private readonly eventsStore: SessionEventStore;
  private readonly bridge: PiEventBridge;
  private readonly emitter: SessionEventEmitter;
  private readonly logger: PiSessionEngineOptions["logger"];
  private readonly sessionSink: SessionEventSink;
  private readonly eventChain: { current: Promise<void> } = { current: Promise.resolve() };

  private orchestrator: SubAgentOrchestrator | null = null;
  private piSession: AgentSession | null = null;
  private planMode = false;
  private planRunId: string | null = null;
  private queued: QueuedInput[] = [];
  private runId: string | null = null;
  private workflowAborted = false;
  private lastCheckpointId: string | null = null;
  private lastCheckpointCoveredSeq = 0;
  private pendingCompactionTrigger: "auto" | "manual" = "auto";
  private restoredCheckpoint: CheckpointRestoredData | null = null;
  private systemPrompt = "";
  private toolDefinitions: readonly ToolDefinition[] = [];
  private autoFollowUpCount = 0;
  private autoFollowUpPending = false;
  private sessionManager: SessionManager | null = null;
  private readonly toolGuard = new ToolExecutionGuard();
  private skills: SkillRegistry | null = null;
  private workflowRunId: string | null = null;
  private unsubscribe: (() => void) | null = null;

  private constructor(options: PiSessionEngineOptions & { initialSeq: number }) {
    this.sessionId = options.session.id;
    this.config = options.config;
    this.database = options.database;
    this.logger = options.logger;
    // 快照模型配置：设置页热切换只影响之后创建的 Session。
    const providerId = options.session.providerId ?? options.modelSetup.providerId;
    const modelId = options.session.modelId ?? options.modelSetup.modelId;
    const model =
      options.modelSetup.modelRuntime.getModel(providerId, modelId) ?? options.modelSetup.model;
    this.modelSetup = { ...options.modelSetup, model, modelId, providerId };
    this.optionsMemory = options.memory;
    this.eventsStore = options.events;
    this.sessionRecord = options.session;
    this.sessionSink = new SessionEventSink(
      options.database,
      options.events,
      options.bus,
      options.logger,
    );
    this.emitter = new SessionEventEmitter(
      options.session.id,
      options.initialSeq,
      this.sessionSink.handle,
    );
    this.backgroundCommands = options.backgroundCommands;
    this.approval = new PiApprovalCoordinator(
      this.emit,
      () => this.runId,
      () => options.database.getSettings().approvalMode,
      (input, signal) => this.reviewHighRiskTool(input, signal),
      (prefix) => {
        if (validateCommandPrefix(prefix)) this.database.addAllowedCommandPrefix(prefix);
      },
    );
    this.userInput = new UserInputCoordinator(this.emit, () => this.runId);
    this.bridge = new PiEventBridge(
      this.emit,
      {
        consumeInternalText: (text) => text.trim() === AUTO_FOLLOW_UP_PROMPT.trim(),
        consumeQueuedText: (text) => this.consumeQueued(text),
        contextUsage: () => {
          const usage = this.piSession?.getContextUsage();
          return usage === undefined || usage.tokens === null
            ? null
            : { limit: usage.contextWindow, tokens: usage.tokens };
        },
        compactionStats: (firstKeptEntryId) => this.getCompactionStats(firstKeptEntryId),
        onQueueUpdate: () => undefined,
        onRequestSnapshot: (requestIndex) =>
          buildRequestSnapshot({
            messages: this.piSession?.messages ?? [],
            model: this.modelSetup.modelId,
            requestIndex,
            runId: this.runId,
            systemPrompt: this.systemPrompt,
            tools: this.toolDefinitions.map((tool) => ({
              description: tool.description ?? "",
              inputSchema: tool.parameters ?? {},
              name: tool.name,
            })),
          }),
        onSettled: () => {
          void this.orchestrator?.abortAll();
          this.planMode = false;
          this.runId = null;
          this.queued = [];
          this.autoFollowUpPending = false;
        },
      },
      () => options.config.model,
      () => this.piSession?.getActiveToolNames() ?? [],
    );
  }

  public static async create(options: PiSessionEngineOptions): Promise<PiSessionEngine> {
    const initialSeq = Math.max(
      options.session.lastSeq,
      await options.events.maxSeq(options.session.id),
    );
    const engine = new PiSessionEngine({ ...options, initialSeq });
    await engine.open();
    return engine;
  }

  public get isRunning(): boolean {
    return this.runId !== null || this.piSession?.isStreaming === true;
  }

  public async setSessionModel(
    providerId: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<void> {
    const model = this.modelSetup.modelRuntime.getModel(providerId, modelId);
    if (model === undefined) throw new Error(`未知模型 "${providerId}/${modelId}"`);
    this.modelSetup.providerId = providerId;
    this.modelSetup.modelId = modelId;
    this.modelSetup.model = model;
    this.sessionRecord.modelId = modelId;
    this.sessionRecord.providerId = providerId;
    this.sessionRecord.thinkingLevel = thinkingLevel;
    if (this.piSession !== null && !this.modelSetup.mock) {
      await this.piSession.setModel(model);
    }
    this.piSession?.setThinkingLevel(
      thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
    );
  }

  public get currentRunId(): string | null {
    return this.runId;
  }

  public get queuedInputs(): QueuedInput[] {
    return this.queued.map((item) => ({ ...item }));
  }

  public get lastSeq(): number {
    return this.emitter.lastSeq;
  }

  public async start(
    text: string,
    images?: readonly MessageImage[],
    memoryRecall?: MemoryRecall,
    planMode = false,
    attachmentContext?: AttachmentContext,
  ): Promise<{ queuedInputId?: string; runId?: string }> {
    if (this.workflowRunId !== null) {
      throw new Error("工作流运行中不能发送普通消息");
    }
    const piSession = this.requireSession();
    const prompt = text.trim();
    if (!prompt && (images === undefined || images.length === 0)) {
      throw new Error("消息不能为空");
    }

    const piImages = toPiImages(images);
    if (!piSession.isStreaming) this.orchestrator?.beginRun();
    if (piSession.isStreaming && planMode) {
      throw new Error("运行中不能切换计划模式");
    }
    if (piSession.isStreaming && attachmentContext !== undefined) {
      throw new Error("运行中暂不支持文档附件");
    }
    if (piSession.isStreaming) {
      const item: QueuedInput = {
        createdAt: Date.now(),
        ...(images === undefined ? {} : { images: [...images] }),
        id: randomUUID(),
        text: prompt,
      };
      this.queued.push(item);
      await piSession.prompt(prompt, {
        ...(piImages === undefined ? {} : { images: piImages }),
        streamingBehavior: "followUp",
      });
      return { queuedInputId: item.id };
    }

    const runId = randomUUID();
    this.runId = runId;
    this.autoFollowUpCount = 0;
    this.autoFollowUpPending = false;
    this.toolGuard.reset();
    this.planMode = planMode;
    this.planRunId = planMode ? runId : null;
    this.bridge.setRun(runId);
    const memoryContext = memoryRecall?.context ?? "";
    const restoredContext =
      this.restoredCheckpoint === null
        ? ""
        : formatCheckpointForPrompt(this.restoredCheckpoint.checkpoint);
    const selectedSkills =
      this.skills === null || !prompt.includes("$") ? [] : await this.skills.resolveRefs(prompt);
    const skillContext =
      selectedSkills.length === 0
        ? ""
        : [
            "【本轮引用的 Skills】",
            ...selectedSkills.map(
              (skill) => `- ${skill.name}：${skill.description.replace(/\s+/gu, " ")}`,
            ),
            "使用前请调用 load_skill(name) 读取正文；不要假设正文已经加载。",
          ].join("\n");
    const contextParts = [
      memoryContext,
      restoredContext,
      skillContext,
      planMode ? PLAN_MODE_PREFIX : "",
      attachmentContext?.context ?? "",
    ].filter((part) => part !== "");
    const contextPrefix = contextParts.join("\n\n");
    this.bridge.setPromptPrefix(contextPrefix === "" ? null : contextPrefix);
    if (memoryRecall !== undefined) {
      await this.emit({
        data: {
          memoryIds: memoryRecall.hits.map((hit) => hit.documentId.replace(/^memory:/u, "")),
          titles: memoryRecall.hits.map((hit) => hit.documentTitle),
        },
        runId,
        type: HarnessEventType.MEMORY_RECALLED,
      });
    }
    if (attachmentContext !== undefined) {
      await this.emit({
        data: { attachments: attachmentContext.attachments } satisfies AttachmentContextData,
        runId,
        type: HarnessEventType.ATTACHMENT_CONTEXT,
      });
    }
    const promptText = contextPrefix === "" ? prompt : `${contextPrefix}\n\n${prompt}`;
    const task = piSession.prompt(
      promptText,
      piImages === undefined ? undefined : { images: piImages },
    );
    this.restoredCheckpoint = null;
    void task
      .then(async () => {
        if (this.planRunId !== runId) return;
        this.planRunId = null;
        const text = lastAssistantText(piSession.messages);
        if (text !== "") {
          await this.emit({
            data: { planId: randomUUID(), text },
            runId,
            type: HarnessEventType.PLAN_CREATED,
          });
        }
      })
      .catch((error: unknown) => {
        void this.failBeforeSettled(runId, error);
      });
    return { runId };
  }

  public async steer(
    text: string,
    images?: readonly MessageImage[],
  ): Promise<"handled" | "queued"> {
    const piSession = this.requireSession();
    const prompt = text.trim();
    if (!prompt && (images === undefined || images.length === 0)) {
      throw new Error("消息不能为空");
    }
    if (!piSession.isStreaming) throw new Error("当前没有运行中的 Run");
    return piSession.steer(prompt, toPiImages(images));
  }

  public async startWorkflow(nodes: readonly WorkflowNodeSpec[]): Promise<{ runId: string }> {
    if (this.isRunning) throw new Error("已有 Run 正在执行");
    if (nodes.length === 0) throw new Error("工作流至少需要一个节点");
    const orchestrator = this.orchestrator;
    if (orchestrator === null) throw new Error("子 Agent 调度器尚未就绪");

    const runId = randomUUID();
    this.runId = runId;
    this.workflowRunId = runId;
    this.workflowAborted = false;
    this.bridge.setRun(runId);
    orchestrator.beginRun();

    await this.emit({
      data: { model: this.config.model, tools: ["run_workflow"] },
      runId,
      type: HarnessEventType.RUN_STARTED,
    });
    await this.emit({
      data: {
        message: {
          content: [{ text: `运行工作流：${nodes.length} 个节点`, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
      },
      runId,
      type: HarnessEventType.MESSAGE_COMPLETED,
    });

    void this.executeWorkflow(runId, nodes).catch((error: unknown) => {
      this.logger.error({ err: error, runId }, "工作流执行异常");
    });
    return { runId };
  }

  public async abort(runId: string): Promise<boolean> {
    if (this.runId !== runId) return false;
    this.planMode = false;
    this.planRunId = null;
    this.queued = [];
    this.approval.cancelAll();
    this.userInput.cancelAll();
    if (this.workflowRunId === runId) {
      this.workflowAborted = true;
      await this.orchestrator?.abortAll();
      return true;
    }
    void this.orchestrator?.abortAll();
    await this.piSession?.abort();
    return true;
  }

  public resolveApproval(
    approvalId: string,
    approved: boolean,
    options: { allowPrefix?: string; grantSession?: boolean } = {},
  ): boolean {
    return this.approval.resolve(approvalId, approved, options);
  }

  public resolveUserInput(inputId: string, answers: readonly UserInputAnswer[]): Promise<boolean> {
    return this.userInput.resolve(inputId, answers);
  }

  public removeQueued(id: string): Promise<boolean> {
    const index = this.queued.findIndex((item) => item.id === id);
    if (index < 0) return Promise.resolve(false);
    this.queued.splice(index, 1);
    const piSession = this.piSession;
    if (piSession?.isStreaming === true) {
      piSession.clearQueue();
      return (async () => {
        for (const item of this.queued) {
          const images = toPiImages(item.images);
          await piSession.followUp(item.text, images === undefined ? undefined : images);
        }
        return true;
      })();
    }
    return Promise.resolve(true);
  }

  private consumeAutoFollowUp(): boolean {
    if (!this.autoFollowUpPending) return false;
    this.autoFollowUpPending = false;
    if (this.planMode || this.autoFollowUpCount >= this.config.autoFollowUpMax) return false;
    this.autoFollowUpCount += 1;
    return true;
  }

  private getCompactionStats(firstKeptEntryId: string): {
    replacedMessages: number;
    retainedFrom?: number;
  } {
    const manager = this.sessionManager;
    if (manager === null) return { replacedMessages: 0 };
    const branch = manager.getBranch();
    const index = branch.findIndex((entry) => entry.id === firstKeptEntryId);
    if (index < 0) return { replacedMessages: 0 };
    const retained = branch[index];
    const replacedMessages = branch
      .slice(0, index)
      .filter((entry) => entry.type === "message").length;
    let retainedFrom: number | undefined;
    if (retained !== undefined) {
      if (retained.type === "message" && typeof retained.message.timestamp === "number") {
        retainedFrom = retained.message.timestamp;
      } else {
        const parsed = Date.parse(retained.timestamp);
        if (Number.isFinite(parsed)) retainedFrom = parsed;
      }
    }
    return { replacedMessages, ...(retainedFrom === undefined ? {} : { retainedFrom }) };
  }

  public async compact(): Promise<void> {
    this.pendingCompactionTrigger = "manual";
    try {
      await this.requireSession().compact();
    } finally {
      this.pendingCompactionTrigger = "auto";
    }
  }

  /** 恢复一个历史检查点；事件立即落盘，结构化状态注入下一次 Run。 */
  public async restoreCheckpoint(checkpointId: string): Promise<ContextCheckpoint | null> {
    if (this.piSession?.isStreaming === true) {
      throw new Error("运行中的 Session 不能恢复检查点");
    }
    const events = await this.eventsStore.read(this.sessionId, 0);
    const found = collectCheckpoints(events).find(
      (checkpoint) => checkpoint.checkpointId === checkpointId,
    );
    if (found === undefined) return null;
    await this.emit({
      data: { checkpoint: found.checkpoint, checkpointId },
      runId: null,
      type: HarnessEventType.CONTEXT_CHECKPOINT_RESTORED,
    });
    this.restoredCheckpoint = { checkpoint: found.checkpoint, checkpointId };
    return found.checkpoint;
  }

  public async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.approval.cancelAll();
    this.userInput.cancelAll();
    await this.orchestrator?.dispose();
    this.orchestrator = null;
    this.planMode = false;
    this.planRunId = null;
    this.workflowAborted = true;
    this.workflowRunId = null;
    this.queued = [];
    this.runId = null;
    this.piSession?.dispose();
    this.piSession = null;
    await this.eventChain.current.catch(() => undefined);
  }

  private async executeWorkflow(runId: string, nodes: readonly WorkflowNodeSpec[]): Promise<void> {
    const orchestrator = this.orchestrator;
    if (orchestrator === null) return;
    try {
      const created = await orchestrator.runDag(nodes);
      const results = await orchestrator.waitForAll(created.map((node) => node.executionId));
      const failed = results.filter((result) => result.status !== "completed");
      const summary = results
        .map(
          (result) =>
            `- ${result.name} [${result.status}]${result.errorCode === undefined ? "" : ` ${result.errorCode}`}`,
        )
        .join("\n");
      await this.emit({
        data: {
          message: {
            content: [
              {
                text: `工作流结果（${results.length - failed.length}/${results.length} 完成）：\n${summary}`,
                type: "text",
              },
            ],
            role: "assistant",
            timestamp: Date.now(),
          },
        },
        runId,
        type: HarnessEventType.MESSAGE_COMPLETED,
      });
      if (this.workflowAborted || runId !== this.workflowRunId) {
        await this.emit({
          data: { message: "工作流已中止" },
          runId,
          type: HarnessEventType.RUN_ABORTED,
        });
      } else if (failed.length > 0) {
        await this.emit({
          data: {
            code: "WORKFLOW_FAILED",
            message: `工作流有 ${failed.length} 个节点失败`,
          },
          runId,
          type: HarnessEventType.RUN_FAILED,
        });
      } else {
        await this.emit({
          data: { steps: results.length },
          runId,
          type: HarnessEventType.RUN_COMPLETED,
        });
      }
    } catch (error: unknown) {
      await this.emit({
        data: {
          code: "WORKFLOW_FAILED",
          message: error instanceof Error ? error.message : "工作流执行失败",
        },
        runId,
        type: HarnessEventType.RUN_FAILED,
      }).catch(() => undefined);
    } finally {
      if (this.runId === runId) this.runId = null;
      if (this.workflowRunId === runId) this.workflowRunId = null;
      this.bridge.clearRun();
    }
  }

  private planModeBlockReason(toolName: string): string | undefined {
    return this.planMode && PLAN_BLOCKED_TOOLS.has(toolName)
      ? "计划模式只允许分析；请先输出计划，确认后再执行副作用操作。"
      : undefined;
  }

  private async reviewHighRiskTool(
    input: PiToolApprovalInput,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (this.modelSetup.mock) return true;
    const timeout = AbortSignal.timeout(8_000);
    const reviewSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const result = await this.modelSetup.modelRuntime.completeSimple(
        this.modelSetup.model,
        {
          messages: [
            {
              content: [{ text: buildApprovalReviewPrompt(input), type: "text" }],
              role: "user",
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 120, signal: reviewSignal },
      );
      if (result.errorMessage !== undefined) return false;
      const text = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      return parseApprovalReview(text) === "allow";
    } catch {
      return false;
    }
  }

  private readonly emit: PiBridgeEmit = async (draft) => {
    if (draft.type !== HarnessEventType.CONTEXT_COMPACTED) return this.emitter.emit(draft);
    const data = await this.enrichCompactedData(draft.data);
    const event = await this.emitter.emit({ ...draft, data });
    this.lastCheckpointId = data.checkpointId;
    this.lastCheckpointCoveredSeq = event.seq;
    this.pendingCompactionTrigger = "auto";
    return event;
  };

  private async enrichCompactedData(input: unknown): Promise<
    ContextCompactedData & {
      checkpointId: string;
      coveredFromSeq: number;
      coveredToSeq: number;
      previousCheckpointId: string | null;
      trigger: "auto" | "manual";
    }
  > {
    const data = (
      typeof input === "object" && input !== null ? input : {}
    ) as Partial<ContextCompactedData>;
    const summary = typeof data.summary === "string" ? data.summary : "";
    let events: readonly HarnessEvent[] = [];
    try {
      events = await this.eventsStore.read(this.sessionId, 0);
    } catch (error: unknown) {
      this.logger.warn({ err: error }, "读取事件失败，检查点仅使用压缩摘要");
    }
    return {
      afterTokens: data.afterTokens ?? 0,
      beforeTokens: data.beforeTokens ?? 0,
      checkpoint: buildContextCheckpoint(events, summary),
      checkpointId: randomUUID(),
      coveredFromSeq: this.lastCheckpointCoveredSeq + 1,
      coveredToSeq: this.emitter.lastSeq + 1,
      previousCheckpointId: this.lastCheckpointId,
      replacedMessages: data.replacedMessages ?? 0,
      ...(data.retainedFrom === undefined ? {} : { retainedFrom: data.retainedFrom }),
      summary,
      trigger: this.pendingCompactionTrigger,
    };
  }

  private async open(): Promise<void> {
    const session = this.sessionRecord;
    const existingEvents = await this.eventsStore.read(session.id, 0);
    const checkpoints = collectCheckpoints(existingEvents);
    const lastCheckpoint = checkpoints.at(-1);
    this.lastCheckpointId = lastCheckpoint?.checkpointId ?? null;
    this.lastCheckpointCoveredSeq = lastCheckpoint?.coveredToSeq ?? 0;
    this.restoredCheckpoint = latestUnconsumedRestore(existingEvents);
    const manager =
      session.piSessionFile === null
        ? SessionManager.create(session.workspaceRoot, this.config.piSessionsDir)
        : SessionManager.open(session.piSessionFile);
    this.sessionManager = manager;
    this.orchestrator = new SubAgentOrchestrator({
      config: this.config,
      database: this.database,
      emit: this.emit,
      getRunId: () => this.runId,
      logger: this.logger,
      modelSetup: this.modelSetup,
      protectedPaths: [this.config.dataDir],
      requestApproval: (input, signal, executionId, options) =>
        this.approval.request(input, signal, executionId, options),
      searchKnowledge: async (query, limit, signal) => {
        signal?.throwIfAborted();
        return this.database.searchKnowledge(query, limit);
      },
      workspaceRoot: session.workspaceRoot,
    });

    const commandRunner = createCommandSandboxRunner({
      config: this.config,
      getSettings: () => this.database.getSettings(),
      logger: this.logger,
    });
    const skillRegistry = new SkillRegistry({
      disabled: this.database.getDisabledSkills(),
      globalDir: this.config.skillsGlobalDir,
      systemDir: this.config.skillsSystemDir,
      workspaceRoot: session.workspaceRoot,
    });
    this.skills = skillRegistry;
    const memoryTools =
      this.optionsMemory === undefined ? [] : createMemoryTools(this.optionsMemory);
    const backgroundTools =
      this.backgroundCommands === undefined
        ? []
        : createBackgroundCommandTools(this.backgroundCommands, session.id, session.workspaceRoot);
    const customTools = toPiTools(
      [
        ...createWorkspaceTools({
          commandRunner,
          networkCheck: (hostname) =>
            sandboxBlockedNetworkReason(this.database.getSettings().sandbox, hostname),
          searxngUrl: this.config.searxngUrl,
          supportsImages: () => this.modelSetup.model.input.includes("image"),
        }),
        createReadDocumentTool(),
        createViewPdfPageTool({
          supportsImages: () => this.modelSetup.model.input.includes("image"),
        }),
        ...createSkillTools(skillRegistry),
        ...createSubAgentTools(this.orchestrator),
        createSessionHistoryTool(() => this.eventsStore.read(this.sessionId, 0)),
        createUserInputTool(this.userInput),
        ...memoryTools,
        ...backgroundTools,
      ],
      {
        onResult: (input) => this.publishToolResult(input),
        blockedToolReason: (toolName) => this.planModeBlockReason(toolName),
        guard: this.toolGuard,
        sandboxBlockedReason: (toolName) =>
          sandboxBlockedToolReason(this.database.getSettings().sandbox, toolName),
        isCommandAllowed: (command) =>
          this.database
            .listAllowedCommandPrefixes()
            .some((prefix) => commandMatchesPrefix(command, prefix)),
        protectedPaths: [this.config.dataDir],
        requestApproval: (input, signal, options) =>
          this.approval.request(input, signal, undefined, options),
        searchKnowledge: async (query, limit, signal) => {
          signal?.throwIfAborted();
          return this.database.searchKnowledge(query, limit);
        },
        workspaceRoot: session.workspaceRoot,
        writeCoordinator: workspaceWriteCoordinator,
      },
    );

    const agentsContext = await loadAgentsContext(session.workspaceRoot, [this.config.dataDir]);
    this.systemPrompt = buildSystemPrompt(
      session.workspaceRoot,
      agentsContext,
      await skillRegistry.catalogText(),
    );
    this.toolDefinitions = customTools;
    const settingsManager = SettingsManager.create(session.workspaceRoot, this.config.piAgentDir);
    const resourceLoader = new DefaultResourceLoader({
      agentDir: this.config.piAgentDir,
      cwd: session.workspaceRoot,
      extensionFactories: [createAutoFollowUpExtension(() => this.consumeAutoFollowUp())],
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt: this.systemPrompt,
    });
    await resourceLoader.reload();

    const { session: piSession } = await createAgentSession({
      agentDir: this.config.piAgentDir,
      cwd: session.workspaceRoot,
      customTools,
      model: this.modelSetup.model,
      modelRuntime: this.modelSetup.modelRuntime,
      noTools: "builtin",
      resourceLoader,
      sessionManager: manager,
      settingsManager,
    });
    this.piSession = piSession;
    if (this.modelSetup.mock) configureMockStream(piSession);
    if (session.thinkingLevel !== null) {
      piSession.setThinkingLevel(
        session.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0],
      );
    }

    const sessionFile = manager.getSessionFile();
    if (sessionFile !== undefined && session.piSessionFile === null) {
      this.database.setSessionPiFile(session.id, sessionFile);
    }

    this.unsubscribe = piSession.subscribe((event) => {
      // 续轮由 agent_before_settle 扩展消费这个标记；这里只记录模型意图，
      // 不再在 message_end 里注入隐藏用户消息。
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        requestsAutoFollowUp(event.message)
      ) {
        this.autoFollowUpPending = true;
      }
      this.eventChain.current = this.eventChain.current
        .then(() => this.bridge.handle(event))
        .catch((error: unknown) => {
          console.error("[pi-bridge] 事件投影失败", error);
        });
    });
  }

  private async failBeforeSettled(runId: string, error: unknown): Promise<void> {
    if (this.runId !== runId) return;
    await this.emitter
      .emit({
        data: {
          code: "PROVIDER",
          message: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
        },
        runId,
        type: HarnessEventType.RUN_FAILED,
      })
      .catch(() => undefined);
    this.runId = null;
    this.queued = [];
    this.bridge.clearRun();
  }

  private async publishToolResult(input: {
    result: ToolResult;
    toolCallId: string;
    toolName: string;
  }): Promise<void> {
    for (const change of input.result.fileChanges ?? []) {
      await this.emitter.emit({
        data: { ...change, toolCallId: input.toolCallId, toolName: input.toolName },
        runId: this.runId,
        type: HarnessEventType.FILE_CHANGED,
      });
    }
    if (input.result.todos !== undefined) {
      await this.emitter.emit({
        data: { todos: input.result.todos },
        runId: this.runId,
        type: HarnessEventType.TODOS_UPDATED,
      });
    }
  }

  private consumeQueued(text: string): string | undefined {
    const normalized = text.trim();
    const index = this.queued.findIndex((item) => item.text === normalized);
    if (index < 0) return undefined;
    const [item] = this.queued.splice(index, 1);
    return item?.id;
  }

  private requireSession(): AgentSession {
    if (this.piSession === null) throw new Error("Session 尚未初始化");
    return this.piSession;
  }
}

function toPiImages(images: readonly MessageImage[] | undefined): ImageContent[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({
    data: image.data,
    mimeType: image.mimeType,
    type: "image",
  }));
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as { content?: unknown; role?: unknown; stopReason?: unknown };
    if (candidate.role !== "assistant") continue;
    if (candidate.stopReason === "error") return "";
    if (!Array.isArray(candidate.content)) continue;
    return candidate.content
      .flatMap((block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? [(block as { text: string }).text]
          : [],
      )
      .join("\n")
      .trim();
  }
  return "";
}
