import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import {
  type AgentMessage,
  AgentRuntime,
  type ContentBlock,
  type ContextCheckpoint,
  createUserMessage,
  type HarnessEvent,
  HarnessEventType,
  isTransientEventType,
  type MessageImage,
  type ModelClient,
  ToolRegistry,
  type UserInputAnswer,
} from "@harness/core";
import { createWorkspaceTools } from "@harness/tools";
import type { HarnessConfig } from "../config";
import type { MemoryService } from "../memory/memory-service";
import { createMemoryTools } from "../memory/memory-tools";
import { buildSystemPrompt } from "../prompts";
import type {
  ApprovalMode,
  HarnessDatabase,
  HarnessSettings,
  SessionRecord,
} from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";
import type { BackgroundCommandService } from "./background-command-service";
import { createBackgroundCommandTools } from "./background-command-tools";
import { applyCodeMerge, previewCodeMerge } from "./code-merge";
import type { StoredCheckpoint } from "./context-checkpoint";
import type { SessionEventBus } from "./event-bus";
import { buildMergeSummary, compareSessionEvents } from "./session-compare";
import { copySessionEvents, findUserMessageSeq } from "./session-fork";
import { projectEvents } from "./session-projections";
import { buildResumePrompt } from "./session-resume";
import type {
  CheckpointComparison,
  QueuedInput,
  RewriteResult,
  SessionController,
  SessionSnapshot,
  StartRunResult,
  WorkflowNodeSpec,
} from "./session-types";
import type { WorkspaceService } from "./workspace-service";

export type { SessionSnapshot } from "./session-types";

const DEFAULT_TITLE = "新对话";
const MAX_MESSAGE_CHARS = 100_000;

export type SessionServiceErrorCode =
  | "ARCHIVED"
  | "BUSY"
  | "CONFLICT"
  | "INVALID"
  | "NOT_FOUND"
  | "RUN_NOT_FOUND";

export class SessionServiceError extends Error {
  public constructor(
    public readonly code: SessionServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionServiceError";
  }
}

export interface SessionServiceLogger {
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface SessionServiceOptions {
  backgroundCommands?: BackgroundCommandService | undefined;
  workspace?: WorkspaceService | undefined;
  bus: SessionEventBus;
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  logger: SessionServiceLogger;
  memory?: MemoryService | undefined;
  modelClient: ModelClient;
}

export class SessionService implements SessionController {
  private readonly bus: SessionEventBus;
  private readonly config: HarnessConfig;
  private readonly database: HarnessDatabase;
  private readonly events: SessionEventStore;
  private readonly backgroundCommands: BackgroundCommandService | undefined;
  private readonly workspace: WorkspaceService | undefined;
  private readonly logger: SessionServiceLogger;
  private readonly memory: MemoryService | undefined;
  private readonly modelClient: ModelClient;
  private readonly runtimePromises = new Map<string, Promise<AgentRuntime>>();
  private readonly runtimes = new Map<string, AgentRuntime>();

  public constructor(options: SessionServiceOptions) {
    this.bus = options.bus;
    this.config = options.config;
    this.database = options.database;
    this.events = options.events;
    this.backgroundCommands = options.backgroundCommands;
    this.workspace = options.workspace;
    this.logger = options.logger;
    this.memory = options.memory;
    this.modelClient = options.modelClient;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.config.workspaceRoot, { recursive: true });
    for (const session of this.database.listSessions(true)) {
      try {
        await this.events.repairTrailingLine(session.id);
      } catch (error: unknown) {
        this.logger.warn({ err: error, sessionId: session.id }, "JSONL 启动修复失败");
      }
    }
  }

  public listAllowedCommandPrefixes(): string[] {
    return this.database.listAllowedCommandPrefixes();
  }

  public removeAllowedCommandPrefix(prefix: string): string[] {
    return this.database.removeAllowedCommandPrefix(prefix);
  }

  public listSessions(includeArchived = false): SessionRecord[] {
    return this.database.listSessions(includeArchived);
  }

  public isSessionRunning(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.isRunning === true;
  }

  public getSession(sessionId: string): SessionRecord {
    const session = this.database.getSession(sessionId);
    if (session === null) throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    return session;
  }

  public async createSession(input: {
    modelId?: string | undefined;
    providerId?: string | undefined;
    thinkingLevel?: string | undefined;
    title?: string | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<SessionRecord> {
    const title = input.title?.trim() || DEFAULT_TITLE;
    if (title.length > 120) throw new SessionServiceError("INVALID", "标题不能超过 120 个字符");
    const workspaceRoot = await this.resolveWorkspace(input.workspaceRoot);
    return this.database.createSession({
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      title,
      workspaceRoot,
    });
  }

  public async updateSessionModel(
    sessionId: string,
    providerId: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<SessionRecord> {
    this.getSession(sessionId);
    const updated = this.database.updateSessionModel(sessionId, providerId, modelId, thinkingLevel);
    if (updated === null) throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    return updated;
  }

  public renameSession(sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new SessionServiceError("INVALID", "标题必须为 1-120 个字符");
    }
    this.getSession(sessionId);
    this.database.updateSessionTitle(sessionId, trimmed);
  }

  public async forkSession(
    sessionId: string,
    fromTimestamp?: number,
    options: { excludeFromTimestamp?: boolean } = {},
  ): Promise<SessionRecord> {
    const source = this.getSession(sessionId);
    if (source.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "已归档的 Session 不能创建分支");
    }
    if (this.runtimes.get(sessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能创建分支");
    }
    const events = await this.events.read(sessionId, 0);
    const messageSeq =
      fromTimestamp === undefined
        ? undefined
        : (findUserMessageSeq(events, fromTimestamp) ?? undefined);
    if (fromTimestamp !== undefined && messageSeq === undefined) {
      throw new SessionServiceError("INVALID", "找不到要分叉的历史消息");
    }
    const maxSeq =
      messageSeq === undefined
        ? undefined
        : options.excludeFromTimestamp === true
          ? Math.max(0, messageSeq - 1)
          : messageSeq;
    const created = this.database.createSession({
      parentSessionId: source.id,
      title: `${source.title} · 分支`.slice(0, 120),
      workspaceRoot: source.workspaceRoot,
    });
    try {
      const lastSeq = await copySessionEvents(this.events, sessionId, created.id, maxSeq);
      if (lastSeq > 0) this.database.setSessionLastSeq(created.id, lastSeq);
    } catch {
      await this.events.remove(created.id);
      this.database.archiveSession(created.id);
      throw new SessionServiceError("INVALID", "复制会话事件失败");
    }
    return this.getSession(created.id);
  }

  public async rewriteSession(
    sessionId: string,
    fromTimestamp: number,
    text: string,
    images?: readonly MessageImage[],
    planMode = false,
  ): Promise<RewriteResult> {
    const prompt = text.trim();
    if (prompt === "" && (images === undefined || images.length === 0)) {
      throw new SessionServiceError("INVALID", "消息不能为空");
    }
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new SessionServiceError("INVALID", "消息过长");
    }
    const branch = await this.forkSession(sessionId, fromTimestamp, {
      excludeFromTimestamp: true,
    });
    if (prompt !== "") {
      this.database.updateSessionTitle(branch.id, `改写：${prompt}`.slice(0, 120));
    }
    const result = await this.startRun(branch.id, prompt, images, planMode);
    return { ...result, session: this.getSession(branch.id) };
  }

  public async previewCodeMerge(
    targetSessionId: string,
    sourceSessionId: string,
  ): Promise<import("./session-types").FileMergePreviewView[]> {
    this.getSession(targetSessionId);
    this.getSession(sourceSessionId);
    const [targetEvents, sourceEvents] = await Promise.all([
      this.events.read(targetSessionId, 0),
      this.events.read(sourceSessionId, 0),
    ]);
    return previewCodeMerge(targetEvents, sourceEvents).map((file) => ({ ...file }));
  }

  public async mergeCode(
    targetSessionId: string,
    sourceSessionId: string,
  ): Promise<{
    files: import("./session-types").FileMergePreviewView[];
    session: SessionRecord;
  }> {
    const target = this.getSession(targetSessionId);
    const source = this.getSession(sourceSessionId);
    if (target.workspaceRoot !== source.workspaceRoot) {
      throw new SessionServiceError("INVALID", "不同 workspace 的会话不能代码合并");
    }
    if (this.workspace === undefined) {
      throw new SessionServiceError("INVALID", "工作区服务未配置");
    }
    const files = await this.previewCodeMerge(targetSessionId, sourceSessionId);
    if (files.some((file) => file.conflict)) {
      throw new SessionServiceError(
        "CONFLICT",
        `代码合并存在冲突：${files
          .filter((file) => file.conflict)
          .map((file) => file.path)
          .join(", ")}`,
      );
    }
    const session = await this.mergeSessions(targetSessionId, sourceSessionId);
    try {
      await applyCodeMerge(files, this.workspace, target.workspaceRoot);
    } catch (error: unknown) {
      this.database.archiveSession(session.id);
      throw new SessionServiceError(
        "INVALID",
        error instanceof Error ? error.message : "应用代码合并失败",
      );
    }
    return { files, session };
  }

  public async compareSessions(
    baseSessionId: string,
    targetSessionId: string,
  ): Promise<import("./session-types").SessionCompareView> {
    const base = this.getSession(baseSessionId);
    const target = this.getSession(targetSessionId);
    const [baseEvents, targetEvents] = await Promise.all([
      this.events.read(baseSessionId, 0),
      this.events.read(targetSessionId, 0),
    ]);
    const diff = compareSessionEvents(baseEvents, targetEvents);
    return {
      base: { ...diff.base, sessionId: base.id, title: base.title },
      commonPrefix: diff.commonPrefix,
      target: { ...diff.target, sessionId: target.id, title: target.title },
    };
  }

  public async mergeSessions(
    targetSessionId: string,
    sourceSessionId: string,
  ): Promise<SessionRecord> {
    const target = this.getSession(targetSessionId);
    const source = this.getSession(sourceSessionId);
    if (target.archivedAt !== null || source.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "已归档的 Session 不能合并");
    }
    if (this.runtimes.get(targetSessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "目标 Session 正在运行，不能合并");
    }
    const sourceEvents = await this.events.read(sourceSessionId, 0);
    const summary = buildMergeSummary(source.title, sourceEvents);
    const created = this.database.createSession({
      parentSessionId: target.id,
      title: `合并 · ${target.title} + ${source.title}`.slice(0, 120),
      workspaceRoot: target.workspaceRoot,
    });
    try {
      const lastSeq = await copySessionEvents(this.events, targetSessionId, created.id);
      if (lastSeq > 0) this.database.setSessionLastSeq(created.id, lastSeq);
      const event: HarnessEvent = {
        data: {
          message: {
            content: [{ text: summary, type: "text" }],
            role: "user",
            timestamp: Date.now(),
          },
        },
        id: randomUUID(),
        runId: null,
        seq: lastSeq + 1,
        sessionId: created.id,
        timestamp: Date.now(),
        type: HarnessEventType.MESSAGE_COMPLETED,
      };
      await this.events.append(event);
      this.database.setSessionLastSeq(created.id, event.seq);
      this.bus.publish(event);
    } catch (error: unknown) {
      await this.events.remove(created.id);
      this.database.archiveSession(created.id);
      throw new SessionServiceError(
        "INVALID",
        error instanceof Error ? error.message : "合并分支失败",
      );
    }
    return this.getSession(created.id);
  }

  public async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.getSession(sessionId);
    const events = await this.events.read(sessionId);
    const projections = projectEvents(events);
    const runtime = this.runtimes.get(sessionId);
    return {
      ...projections,
      isRunning: runtime?.isRunning ?? false,
      lastSeq: Math.max(session.lastSeq, runtime?.lastSeq ?? 0, events.at(-1)?.seq ?? 0),
      messages: runtime?.history ?? messagesFromEvents(events),
      queued: runtime?.queuedInputs ?? [],
      runId: runtime?.currentRunId ?? null,
      session,
    };
  }

  public readEvents(sessionId: string, afterSeq: number): Promise<HarnessEvent[]> {
    this.getSession(sessionId);
    return this.events.read(sessionId, afterSeq);
  }

  public async startRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
    planMode = false,
    attachments?: readonly string[],
  ): Promise<StartRunResult> {
    if (attachments !== undefined && attachments.length > 0) {
      throw new SessionServiceError("INVALID", "builtin 引擎暂不支持文档附件");
    }
    if (planMode) {
      throw new SessionServiceError("INVALID", "builtin 引擎暂不支持计划模式");
    }
    if (images !== undefined && images.length > 0) {
      throw new SessionServiceError("INVALID", "builtin 引擎暂不支持图片附件");
    }
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    const prompt = text.trim();
    if (!prompt) throw new SessionServiceError("INVALID", "消息不能为空");
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new SessionServiceError("INVALID", "消息过长");
    }

    const runtime = await this.ensureRuntime(session);
    if (runtime.isRunning) {
      const item = runtime.enqueueInput(prompt);
      this.database.touchSession(sessionId, Date.now());
      return { queuedInputId: item.id };
    }

    if (session.title === DEFAULT_TITLE) {
      const title = prompt.replace(/\s+/gu, " ").slice(0, 40);
      this.database.updateSessionTitle(sessionId, title);
    }

    let started: { done: Promise<void>; runId: string };
    try {
      started = runtime.startRun(prompt);
    } catch (error: unknown) {
      throw new SessionServiceError("BUSY", errorMessage(error));
    }
    started.done.catch((error: unknown) => {
      this.logger.error({ err: error, runId: started.runId, sessionId }, "Session Run 异常结束");
    });
    this.database.touchSession(sessionId, Date.now());
    return { runId: started.runId };
  }

  public async steerRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
  ): Promise<"handled" | "queued"> {
    this.getSession(sessionId);
    if (images !== undefined && images.length > 0) {
      throw new SessionServiceError("INVALID", "builtin 引擎暂不支持图片附件");
    }
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined || !runtime.isRunning) {
      throw new SessionServiceError("RUN_NOT_FOUND", "当前没有运行中的 Run");
    }
    const prompt = text.trim();
    if (!prompt) throw new SessionServiceError("INVALID", "消息不能为空");
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new SessionServiceError("INVALID", "消息过长");
    }
    runtime.enqueueInput(prompt);
    return "queued";
  }

  public async startWorkflow(
    _sessionId: string,
    _nodes: readonly WorkflowNodeSpec[],
  ): Promise<{ runId: string }> {
    throw new SessionServiceError("INVALID", "builtin 引擎不支持直接运行工作流");
  }

  public listQueued(sessionId: string): QueuedInput[] {
    this.getSession(sessionId);
    return this.runtimes.get(sessionId)?.queuedInputs ?? [];
  }

  public async removeQueued(sessionId: string, inputId: string): Promise<boolean> {
    this.getSession(sessionId);
    return this.runtimes.get(sessionId)?.removeQueuedInput(inputId) ?? false;
  }

  public async compact(_sessionId: string): Promise<void> {
    throw new SessionServiceError(
      "INVALID",
      "builtin 引擎使用自动压缩；请使用 pi 引擎触发手动压缩",
    );
  }

  public async listCheckpoints(_sessionId: string): Promise<StoredCheckpoint[]> {
    return [];
  }

  public async compareCheckpoints(
    _sessionId: string,
    _baseId: string,
    _targetId: string,
  ): Promise<CheckpointComparison> {
    throw new SessionServiceError("NOT_FOUND", "builtin 引擎没有结构化检查点");
  }

  public async restoreCheckpoint(
    _sessionId: string,
    _checkpointId: string,
  ): Promise<ContextCheckpoint> {
    throw new SessionServiceError("INVALID", "builtin 引擎不支持恢复检查点");
  }

  public abort(sessionId: string, runId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined || !runtime.abort(runId)) {
      throw new SessionServiceError("RUN_NOT_FOUND", "没有匹配的活动 Run");
    }
    return true;
  }

  public resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    options: { allowPrefix?: string; grantSession?: boolean } = {},
  ): boolean {
    if (approved && options.allowPrefix !== undefined) {
      this.database.addAllowedCommandPrefix(options.allowPrefix);
    }
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined || !runtime.resolveApproval(approvalId, approved)) {
      throw new SessionServiceError("RUN_NOT_FOUND", "审批请求不存在或已失效");
    }
    return true;
  }

  public async resolveUserInput(
    sessionId: string,
    _inputId: string,
    _answers: readonly UserInputAnswer[],
  ): Promise<boolean> {
    this.getSession(sessionId);
    throw new SessionServiceError("INVALID", "builtin 引擎不支持交互式提问");
  }

  public archiveSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) return;
    const runtime = this.runtimes.get(sessionId);
    if (runtime?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能归档");
    }
    this.backgroundCommands?.stopSession(sessionId);
    this.database.archiveSession(sessionId);
    this.runtimes.delete(sessionId);
    this.bus.clearSession(sessionId);
  }

  public async resumeSession(sessionId: string): Promise<StartRunResult> {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    if (this.runtimes.get(sessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能续跑");
    }
    const events = await this.events.read(sessionId, 0);
    return this.startRun(sessionId, buildResumePrompt(events));
  }

  public restoreSession(sessionId: string): void {
    const session = this.database.getSession(sessionId);
    if (session === null) throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    if (session.archivedAt === null) return;
    if (!this.database.restoreSession(sessionId)) {
      throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    }
  }

  public getDisabledSkills(): string[] {
    return this.database.getDisabledSkills();
  }

  public setSkillEnabled(
    scope: "global" | "project" | "system",
    id: string,
    enabled: boolean,
  ): string[] {
    return this.database.setSkillEnabled(scope, id, enabled);
  }

  public getSettings(): HarnessSettings {
    return this.database.getSettings();
  }

  public setApprovalMode(mode: ApprovalMode): HarnessSettings {
    this.database.setApprovalMode(mode);
    return this.database.getSettings();
  }

  public setSandboxSettings(input: import("@harness/sandbox").SandboxSettings): HarnessSettings {
    return this.database.setSandboxSettings(input);
  }

  public close(): void {
    for (const runtime of this.runtimes.values()) {
      const runId = runtime.currentRunId;
      if (runId !== null) runtime.abort(runId);
    }
    this.runtimes.clear();
  }

  private async ensureRuntime(session: SessionRecord): Promise<AgentRuntime> {
    const existing = this.runtimes.get(session.id);
    if (existing !== undefined) return existing;
    const pending = this.runtimePromises.get(session.id);
    if (pending !== undefined) return pending;

    const promise = this.createRuntime(session)
      .then((runtime) => {
        this.runtimes.set(session.id, runtime);
        return runtime;
      })
      .finally(() => {
        this.runtimePromises.delete(session.id);
      });
    this.runtimePromises.set(session.id, promise);
    return promise;
  }

  private async createRuntime(session: SessionRecord): Promise<AgentRuntime> {
    const events = await this.events.read(session.id);
    const messages = messagesFromEvents(events);
    const lastSeq = Math.max(session.lastSeq, events.at(-1)?.seq ?? 0);
    const tools = new ToolRegistry();
    for (const tool of createWorkspaceTools()) tools.register(tool);
    if (this.memory !== undefined) {
      for (const tool of createMemoryTools(this.memory)) tools.register(tool);
    }
    if (this.backgroundCommands !== undefined) {
      for (const tool of createBackgroundCommandTools(
        this.backgroundCommands,
        session.id,
        session.workspaceRoot,
      )) {
        tools.register(tool);
      }
    }

    return new AgentRuntime({
      autoApprove: () => this.database.getSettings().approvalMode !== "request_approval",
      initialMessages: messages,
      initialSeq: lastSeq,
      maxTokens: this.config.maxTokens,
      model: this.config.model,
      modelClient: this.modelClient,
      protectedPaths: [this.config.dataDir],
      searchKnowledge: async (query, limit, signal) => {
        signal?.throwIfAborted();
        return this.database.searchKnowledge(query, limit);
      },
      sessionId: session.id,
      sink: (event) => this.handleEvent(event),
      systemPrompt: buildSystemPrompt(session.workspaceRoot),
      tools,
      workspaceRoot: session.workspaceRoot,
    });
  }

  private async handleEvent(event: HarnessEvent): Promise<void> {
    if (!isTransientEventType(event.type)) {
      try {
        await this.events.append(event);
      } catch (error: unknown) {
        this.bus.publish(event);
        this.logger.error(
          { err: error, sessionId: event.sessionId, type: event.type },
          "事件写入 JSONL 失败",
        );
        throw error;
      }
      try {
        this.database.setSessionLastSeq(event.sessionId, event.seq);
        this.database.touchSession(event.sessionId, event.timestamp);
      } catch (error: unknown) {
        // JSONL 是事实来源；索引更新失败不应让 Run 失败。
        this.logger.error(
          { err: error, sessionId: event.sessionId, type: event.type },
          "事件索引更新失败",
        );
      }
    }
    this.bus.publish(event);
  }

  private async resolveWorkspace(requested: string | undefined): Promise<string> {
    if (requested === undefined) {
      await mkdir(this.config.workspaceRoot, { recursive: true });
      return realpath(this.config.workspaceRoot);
    }
    try {
      const resolved = await realpath(requested);
      if (!(await stat(resolved)).isDirectory()) throw new Error("不是目录");
      return resolved;
    } catch {
      throw new SessionServiceError("INVALID", "workspace 目录不存在或无法访问");
    }
  }
}

function messagesFromEvents(events: readonly HarnessEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const event of events) {
    if (event.type === HarnessEventType.CONTEXT_COMPACTED) {
      const summary =
        isRecord(event.data) && typeof event.data.summary === "string" ? event.data.summary : "";
      if (summary.trim() === "") continue;
      const retainedFrom =
        isRecord(event.data) && typeof event.data.retainedFrom === "number"
          ? event.data.retainedFrom
          : event.timestamp;
      const retained = messages.filter((message) => message.timestamp >= retainedFrom);
      messages.length = 0;
      messages.push(
        createUserMessage(
          `[早期对话摘要]
${summary.trim()}`,
          event.timestamp,
        ),
        ...retained,
      );
      continue;
    }
    if (event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
    if (!isRecord(event.data) || event.data.hidden === true) continue;
    if (!isAgentMessage(event.data.message)) continue;
    messages.push(event.data.message);
  }
  return messages;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  if (typeof value.timestamp !== "number" || !Array.isArray(value.content)) return false;
  return value.content.every(isContentBlock);
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "tool_use") {
    return typeof value.id === "string" && typeof value.name === "string" && "input" in value;
  }
  if (value.type === "tool_result") {
    return typeof value.toolUseId === "string" && typeof value.content === "string";
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
