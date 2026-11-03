import { mkdir, realpath, stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type HarnessEvent,
  type MessageImage,
  SessionEventEmitter,
  type UserInputAnswer,
} from "@harness/core";
import type { HarnessConfig } from "../config";
import type { MemoryService } from "../memory/memory-service";
import type { PiModelSetup } from "../pi/model";
import { PiSessionEngine } from "../pi/session-engine";
import type { HarnessDatabase, HarnessSettings, SessionRecord } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";
import type { AttachmentService } from "./attachment-service";
import type { BackgroundCommandService } from "./background-command-service";
import { applyCodeMerge, previewCodeMerge } from "./code-merge";
import {
  collectCheckpoints,
  compareCheckpoints as compareCheckpointStates,
} from "./context-checkpoint";
import type { SessionEventBus } from "./event-bus";
import { SessionEventSink } from "./event-sink";
import { buildMergeSummary, compareSessionEvents } from "./session-compare";
import { copySessionEvents, findUserMessageSeq } from "./session-fork";
import { projectEvents } from "./session-projections";
import { planSessionRecovery } from "./session-recovery";
import { buildResumePrompt } from "./session-resume";
import { SessionServiceError } from "./session-service";
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

const DEFAULT_TITLE = "新对话";
const MAX_MESSAGE_CHARS = 100_000;

export interface PiSessionServiceLogger {
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface PiSessionServiceOptions {
  attachments?: AttachmentService | undefined;
  backgroundCommands?: BackgroundCommandService | undefined;
  bus: SessionEventBus;
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  logger: PiSessionServiceLogger;
  memory?: MemoryService | undefined;
  modelSetup: PiModelSetup;
  workspace?: WorkspaceService | undefined;
}

/** 使用 pi AgentSession 作为执行内核，同时保留我们的事件/HTTP/Web 契约。 */
export class PiSessionService implements SessionController {
  private readonly engines = new Map<string, PiSessionEngine>();
  private readonly enginePromises = new Map<string, Promise<PiSessionEngine>>();

  public constructor(private readonly options: PiSessionServiceOptions) {}

  public async initialize(): Promise<void> {
    await mkdir(this.options.config.workspaceRoot, { recursive: true });
    await mkdir(this.options.config.piAgentDir, { recursive: true });
    await mkdir(this.options.config.piSessionsDir, { recursive: true });
    for (const session of this.options.database.listSessions(true)) {
      try {
        await this.options.events.repairTrailingLine(session.id);
      } catch (error: unknown) {
        this.options.logger.warn({ err: error, sessionId: session.id }, "JSONL 启动修复失败");
      }
    }

    const sink = new SessionEventSink(
      this.options.database,
      this.options.events,
      this.options.bus,
      this.options.logger,
    );
    for (const session of this.options.database.listSessions()) {
      try {
        const events = await this.options.events.read(session.id, 0);
        const drafts = planSessionRecovery(events);
        if (drafts.length === 0) continue;
        const emitter = new SessionEventEmitter(
          session.id,
          Math.max(session.lastSeq, events.at(-1)?.seq ?? 0),
          sink.handle,
        );
        for (const draft of drafts) await emitter.emit(draft);
        this.options.logger.warn(
          { recovered: drafts.length, sessionId: session.id },
          "已补偿 daemon 重启前未结束的审批/子 Agent/Run",
        );
      } catch (error: unknown) {
        this.options.logger.warn({ err: error, sessionId: session.id }, "会话恢复扫描失败");
      }
    }
  }

  public listAllowedCommandPrefixes(): string[] {
    return this.options.database.listAllowedCommandPrefixes();
  }

  public removeAllowedCommandPrefix(prefix: string): string[] {
    return this.options.database.removeAllowedCommandPrefix(prefix);
  }

  public listSessions(includeArchived = false): SessionRecord[] {
    return this.options.database.listSessions(includeArchived);
  }

  public isSessionRunning(sessionId: string): boolean {
    return this.engines.get(sessionId)?.isRunning === true;
  }

  public getSession(sessionId: string): SessionRecord {
    const session = this.options.database.getSession(sessionId);
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
    return this.options.database.createSession({
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
    const session = this.getSession(sessionId);
    if (this.engines.get(sessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能切换模型");
    }
    const engine = this.engines.get(sessionId);
    if (engine !== undefined) {
      await engine.setSessionModel(providerId, modelId, thinkingLevel);
    }
    const updated = this.options.database.updateSessionModel(
      session.id,
      providerId,
      modelId,
      thinkingLevel,
    );
    if (updated === null) throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    return updated;
  }

  public renameSession(sessionId: string, title: string): void {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120) {
      throw new SessionServiceError("INVALID", "标题必须为 1-120 个字符");
    }
    this.getSession(sessionId);
    this.options.database.updateSessionTitle(sessionId, trimmed);
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
    if (this.engines.get(sessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能创建分支");
    }

    const sourceEvents = await this.options.events.read(sessionId, 0);
    const messageSeq =
      fromTimestamp === undefined
        ? undefined
        : (findUserMessageSeq(sourceEvents, fromTimestamp) ?? undefined);
    if (fromTimestamp !== undefined && messageSeq === undefined) {
      throw new SessionServiceError("INVALID", "找不到要分叉的历史消息");
    }
    const maxSeq =
      messageSeq === undefined
        ? undefined
        : options.excludeFromTimestamp === true
          ? Math.max(0, messageSeq - 1)
          : messageSeq;
    if (fromTimestamp !== undefined && source.piSessionFile === null) {
      throw new SessionServiceError("INVALID", "该消息没有可复制的 pi 上下文");
    }

    const created = this.options.database.createSession({
      ...(source.modelId === null ? {} : { modelId: source.modelId }),
      parentSessionId: source.id,
      ...(source.providerId === null ? {} : { providerId: source.providerId }),
      ...(source.thinkingLevel === null ? {} : { thinkingLevel: source.thinkingLevel }),
      title: `${source.title} · 分支`.slice(0, 120),
      workspaceRoot: source.workspaceRoot,
    });

    try {
      if (source.piSessionFile !== null) {
        if (fromTimestamp === undefined) {
          const manager = SessionManager.forkFrom(
            source.piSessionFile,
            source.workspaceRoot,
            this.options.config.piSessionsDir,
            { id: created.id },
          );
          const file = manager.getSessionFile();
          if (file !== undefined) this.options.database.setSessionPiFile(created.id, file);
        } else {
          const manager = SessionManager.open(source.piSessionFile);
          const entry = manager
            .getEntries()
            .filter(
              (item) =>
                item.type === "message" &&
                typeof item.message === "object" &&
                item.message !== null &&
                "role" in item.message &&
                item.message.role === "user" &&
                "timestamp" in item.message &&
                item.message.timestamp === fromTimestamp,
            )
            .at(-1);
          if (entry === undefined) {
            throw new SessionServiceError("INVALID", "pi 历史中找不到对应消息");
          }
          // 改写第一条消息时没有父 entry，新分支从空 pi 上下文开始。
          const leafId = options.excludeFromTimestamp === true ? entry.parentId : entry.id;
          if (leafId !== null) {
            const file = manager.createBranchedSession(leafId);
            if (file === undefined) {
              throw new SessionServiceError("INVALID", "创建 pi 分支失败");
            }
            this.options.database.setSessionPiFile(created.id, file);
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof SessionServiceError) throw error;
      this.options.logger.warn(
        { err: error, sessionId, fromTimestamp },
        "复制 pi Session 失败，新分支将从空上下文开始",
      );
    }

    try {
      const lastSeq = await copySessionEvents(this.options.events, sessionId, created.id, maxSeq);
      if (lastSeq > 0) this.options.database.setSessionLastSeq(created.id, lastSeq);
    } catch {
      await this.options.events.remove(created.id);
      this.options.database.archiveSession(created.id);
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
      this.options.database.updateSessionTitle(branch.id, `改写：${prompt}`.slice(0, 120));
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
      this.options.events.read(targetSessionId, 0),
      this.options.events.read(sourceSessionId, 0),
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
    if (this.options.workspace === undefined) {
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
      await applyCodeMerge(files, this.options.workspace, target.workspaceRoot);
    } catch (error: unknown) {
      this.options.database.archiveSession(session.id);
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
      this.options.events.read(baseSessionId, 0),
      this.options.events.read(targetSessionId, 0),
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
    if (this.engines.get(targetSessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "目标 Session 正在运行，不能合并");
    }
    const sourceEvents = await this.options.events.read(sourceSessionId, 0);
    const summary = buildMergeSummary(source.title, sourceEvents);
    const created = this.options.database.createSession({
      ...(target.modelId === null ? {} : { modelId: target.modelId }),
      parentSessionId: target.id,
      ...(target.providerId === null ? {} : { providerId: target.providerId }),
      ...(target.thinkingLevel === null ? {} : { thinkingLevel: target.thinkingLevel }),
      title: `合并 · ${target.title} + ${source.title}`.slice(0, 120),
      workspaceRoot: target.workspaceRoot,
    });

    try {
      const manager =
        target.piSessionFile === null
          ? SessionManager.create(target.workspaceRoot, this.options.config.piSessionsDir, {
              id: created.id,
            })
          : SessionManager.forkFrom(
              target.piSessionFile,
              target.workspaceRoot,
              this.options.config.piSessionsDir,
              { id: created.id },
            );
      manager.appendMessage({
        content: [{ text: summary, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      });
      const file = manager.getSessionFile();
      if (file !== undefined) this.options.database.setSessionPiFile(created.id, file);

      const lastSeq = await copySessionEvents(this.options.events, targetSessionId, created.id);
      if (lastSeq > 0) this.options.database.setSessionLastSeq(created.id, lastSeq);

      const sink = new SessionEventSink(
        this.options.database,
        this.options.events,
        this.options.bus,
        this.options.logger,
      );
      const emitter = new SessionEventEmitter(created.id, lastSeq, sink.handle);
      await emitter.emit({
        data: {
          message: {
            content: [{ text: summary, type: "text" }],
            role: "user",
            timestamp: Date.now(),
          },
        },
        runId: null,
        type: "message.completed",
      });
    } catch (error: unknown) {
      this.options.logger.warn({ err: error, sessionId: targetSessionId }, "合并分支失败");
      await this.options.events.remove(created.id);
      this.options.database.archiveSession(created.id);
      throw new SessionServiceError(
        "INVALID",
        error instanceof Error ? error.message : "合并分支失败",
      );
    }
    return this.getSession(created.id);
  }

  public async getSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.getSession(sessionId);
    const events = await this.options.events.read(sessionId);
    const projections = projectEvents(events);
    const engine = this.engines.get(sessionId);
    return {
      ...projections,
      isRunning: engine?.isRunning ?? false,
      lastSeq: Math.max(session.lastSeq, engine?.lastSeq ?? 0, events.at(-1)?.seq ?? 0),
      messages: messagesFromEvents(events),
      queued: engine?.queuedInputs ?? [],
      runId: engine?.currentRunId ?? null,
      session,
    };
  }

  public readEvents(sessionId: string, afterSeq: number): Promise<HarnessEvent[]> {
    this.getSession(sessionId);
    return this.options.events.read(sessionId, afterSeq);
  }

  public async startRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
    planMode = false,
    attachments?: readonly string[],
  ): Promise<StartRunResult> {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    const prompt = text.trim();
    if (!prompt && (images === undefined || images.length === 0)) {
      throw new SessionServiceError("INVALID", "消息不能为空");
    }
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new SessionServiceError("INVALID", "消息过长");
    }

    const engine = await this.getOrCreateEngine(session);
    if (session.title === DEFAULT_TITLE && prompt !== "") {
      const title = prompt.replace(/\s+/gu, " ").slice(0, 40);
      this.options.database.updateSessionTitle(sessionId, title);
    }
    const recalled =
      this.options.memory === undefined ? undefined : await this.options.memory.recall(prompt, 5);
    const attachmentContext = this.options.attachments?.buildContext(sessionId, attachments ?? []);
    const result = await engine.start(
      prompt,
      images,
      recalled === undefined ? undefined : { context: recalled.context, hits: recalled.hits },
      planMode,
      attachmentContext,
    );
    this.options.database.touchSession(sessionId, Date.now());
    return result;
  }

  public async steerRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
  ): Promise<"handled" | "queued"> {
    this.getSession(sessionId);
    const engine = this.engines.get(sessionId);
    if (engine === undefined || !engine.isRunning) {
      throw new SessionServiceError("RUN_NOT_FOUND", "当前没有运行中的 Run");
    }
    const prompt = text.trim();
    if (!prompt && (images === undefined || images.length === 0)) {
      throw new SessionServiceError("INVALID", "消息不能为空");
    }
    if (prompt.length > MAX_MESSAGE_CHARS) {
      throw new SessionServiceError("INVALID", "消息过长");
    }
    try {
      return await engine.steer(prompt, images);
    } catch (error: unknown) {
      throw new SessionServiceError("INVALID", errorMessage(error));
    }
  }

  public async startWorkflow(
    sessionId: string,
    nodes: readonly WorkflowNodeSpec[],
  ): Promise<{ runId: string }> {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    const engine = await this.getOrCreateEngine(session);
    try {
      return await engine.startWorkflow(nodes);
    } catch (error: unknown) {
      throw new SessionServiceError("BUSY", errorMessage(error));
    }
  }

  public async abort(sessionId: string, runId: string): Promise<boolean> {
    const engine = this.engines.get(sessionId);
    if (engine === undefined || !(await engine.abort(runId))) {
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
    const engine = this.engines.get(sessionId);
    if (engine === undefined || !engine.resolveApproval(approvalId, approved, options)) {
      throw new SessionServiceError("RUN_NOT_FOUND", "审批请求不存在或已失效");
    }
    return true;
  }

  public async resolveUserInput(
    sessionId: string,
    inputId: string,
    answers: readonly UserInputAnswer[],
  ): Promise<boolean> {
    const engine = this.engines.get(sessionId);
    if (engine === undefined || !(await engine.resolveUserInput(inputId, answers))) {
      throw new SessionServiceError("RUN_NOT_FOUND", "提问已失效");
    }
    return true;
  }

  public listQueued(sessionId: string): QueuedInput[] {
    this.getSession(sessionId);
    return this.engines.get(sessionId)?.queuedInputs ?? [];
  }

  public async removeQueued(sessionId: string, inputId: string): Promise<boolean> {
    this.getSession(sessionId);
    return this.engines.get(sessionId)?.removeQueued(inputId) ?? false;
  }

  public async compact(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    const engine = await this.getOrCreateEngine(session);
    try {
      await engine.compact();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SessionServiceError("INVALID", message);
    }
  }

  public async listCheckpoints(sessionId: string) {
    this.getSession(sessionId);
    const events = await this.options.events.read(sessionId, 0);
    return collectCheckpoints(events);
  }

  public async compareCheckpoints(
    sessionId: string,
    baseId: string,
    targetId: string,
  ): Promise<CheckpointComparison> {
    const checkpoints = await this.listCheckpoints(sessionId);
    const base = checkpoints.find((checkpoint) => checkpoint.checkpointId === baseId);
    const target = checkpoints.find((checkpoint) => checkpoint.checkpointId === targetId);
    if (base === undefined || target === undefined) {
      throw new SessionServiceError("NOT_FOUND", "检查点不存在");
    }
    return {
      base,
      fields: compareCheckpointStates(base.checkpoint, target.checkpoint),
      target,
    };
  }

  public async restoreCheckpoint(sessionId: string, checkpointId: string) {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    const engine = await this.getOrCreateEngine(session);
    if (engine.isRunning) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能恢复检查点");
    }
    try {
      const checkpoint = await engine.restoreCheckpoint(checkpointId);
      if (checkpoint === null) throw new SessionServiceError("NOT_FOUND", "检查点不存在");
      return checkpoint;
    } catch (error: unknown) {
      if (error instanceof SessionServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SessionServiceError("INVALID", message);
    }
  }

  public archiveSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) return;
    const engine = this.engines.get(sessionId);
    if (engine?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能归档");
    }
    this.engines.delete(sessionId);
    void engine?.close();
    this.options.backgroundCommands?.stopSession(sessionId);
    this.options.database.archiveSession(sessionId);
    this.options.bus.clearSession(sessionId);
  }

  public async resumeSession(sessionId: string): Promise<StartRunResult> {
    const session = this.getSession(sessionId);
    if (session.archivedAt !== null) {
      throw new SessionServiceError("ARCHIVED", "Session 已归档");
    }
    if (this.engines.get(sessionId)?.isRunning === true) {
      throw new SessionServiceError("BUSY", "运行中的 Session 不能续跑");
    }
    const events = await this.options.events.read(sessionId, 0);
    return this.startRun(sessionId, buildResumePrompt(events));
  }

  public restoreSession(sessionId: string): void {
    const session = this.options.database.getSession(sessionId);
    if (session === null) throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    if (session.archivedAt === null) return;
    if (!this.options.database.restoreSession(sessionId)) {
      throw new SessionServiceError("NOT_FOUND", "Session 不存在");
    }
  }

  public getDisabledSkills(): string[] {
    return this.options.database.getDisabledSkills();
  }

  public setSkillEnabled(
    scope: "global" | "project" | "system",
    id: string,
    enabled: boolean,
  ): string[] {
    return this.options.database.setSkillEnabled(scope, id, enabled);
  }

  public getSettings(): HarnessSettings {
    return this.options.database.getSettings();
  }

  public setApprovalMode(mode: HarnessSettings["approvalMode"]): HarnessSettings {
    this.options.database.setApprovalMode(mode);
    return this.options.database.getSettings();
  }

  public setSandboxSettings(input: import("@harness/sandbox").SandboxSettings): HarnessSettings {
    return this.options.database.setSandboxSettings(input);
  }

  public async close(): Promise<void> {
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.all(engines.map((engine) => engine.close()));
  }

  private async getOrCreateEngine(session: SessionRecord): Promise<PiSessionEngine> {
    const existing = this.engines.get(session.id);
    if (existing !== undefined) return existing;
    const pending = this.enginePromises.get(session.id);
    if (pending !== undefined) return pending;

    const promise = PiSessionEngine.create({
      backgroundCommands: this.options.backgroundCommands,
      bus: this.options.bus,
      config: this.options.config,
      database: this.options.database,
      events: this.options.events,
      logger: this.options.logger,
      memory: this.options.memory,
      modelSetup: this.options.modelSetup,
      session,
    })
      .then((engine) => {
        this.engines.set(session.id, engine);
        return engine;
      })
      .finally(() => {
        this.enginePromises.delete(session.id);
      });
    this.enginePromises.set(session.id, promise);
    return promise;
  }

  private async resolveWorkspace(requested: string | undefined): Promise<string> {
    if (requested === undefined) {
      await mkdir(this.options.config.workspaceRoot, { recursive: true });
      return realpath(this.options.config.workspaceRoot);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function messagesFromEvents(events: readonly HarnessEvent[]): SessionSnapshot["messages"] {
  const messages: SessionSnapshot["messages"] = [];
  for (const event of events) {
    if (event.type === "context.compacted") {
      const data = event.data as { summary?: unknown } | null;
      const summary = typeof data?.summary === "string" ? data.summary : "";
      messages.length = 0;
      if (summary.trim() !== "") {
        messages.push({
          content: [{ text: `[早期对话摘要]\n${summary.trim()}`, type: "text" }],
          role: "user",
          timestamp: event.timestamp,
        });
      }
      continue;
    }
    if (event.type !== "message.completed") continue;
    const data = event.data as { hidden?: unknown; message?: unknown } | null;
    if (data?.hidden === true) continue;
    if (isAgentMessage(data?.message)) messages.push(data.message);
  }
  return messages;
}

function isAgentMessage(value: unknown): value is SessionSnapshot["messages"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as { content?: unknown; role?: unknown; timestamp?: unknown };
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.timestamp === "number" &&
    Array.isArray(message.content)
  );
}
