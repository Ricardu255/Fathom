import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type BoardTaskProgress,
  BoardTaskStatus,
  type BoardTaskView,
  type HarnessEvent,
  HarnessEventType,
  type TodoItem,
} from "@harness/core";
import type { HarnessConfig } from "../config";
import type { BoardTaskRecord, HarnessDatabase } from "../storage/database";
import type { SessionEventStore } from "../storage/event-store";
import type { SessionController } from "./session-types";

const DEFAULT_TITLE_MAX = 120;
const MAX_OBJECTIVE_CHARS = 20_000;

export type BoardTaskErrorCode = "ARCHIVED" | "BUSY" | "CONFLICT" | "INVALID" | "NOT_FOUND";

export class BoardTaskServiceError extends Error {
  public constructor(
    public readonly code: BoardTaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardTaskServiceError";
  }
}

export interface BoardTaskServiceOptions {
  config: HarnessConfig;
  database: HarnessDatabase;
  events: SessionEventStore;
  sessions: SessionController;
}

export interface BoardTaskWorkspace {
  name: string;
  root: string;
}

/** 用户自建任务：任务 → Session/Run → 事件派生状态。 */
export class BoardTaskService {
  private readonly startingTasks = new Set<string>();

  public constructor(private readonly options: BoardTaskServiceOptions) {}

  public async list(): Promise<BoardTaskView[]> {
    const records = this.options.database.listBoardTasks();
    return Promise.all(records.map((record) => this.toView(record)));
  }

  public async get(id: string): Promise<BoardTaskView> {
    return this.toView(this.requireTask(id));
  }

  public async create(input: {
    objective: string;
    title: string;
    workspaceRoot?: string | undefined;
  }): Promise<BoardTaskView> {
    const title = input.title.trim();
    const objective = input.objective.trim();
    if (title === "" || title.length > DEFAULT_TITLE_MAX) {
      throw new BoardTaskServiceError("INVALID", "标题必须为 1-120 个字符");
    }
    if (objective === "" || objective.length > MAX_OBJECTIVE_CHARS) {
      throw new BoardTaskServiceError("INVALID", `任务目标必须为 1-${MAX_OBJECTIVE_CHARS} 个字符`);
    }
    const workspaceRoot = await this.resolveWorkspace(input.workspaceRoot);
    return this.toView(
      this.options.database.createBoardTask({
        id: randomUUID(),
        objective,
        title,
        workspaceRoot,
      }),
    );
  }

  public async update(
    id: string,
    input: { objective?: string | undefined; title?: string | undefined },
  ): Promise<BoardTaskView> {
    const record = this.requireTask(id);
    const current = await this.toView(record);
    if (current.status === BoardTaskStatus.IN_PROGRESS) {
      throw new BoardTaskServiceError("BUSY", "运行中的任务不能修改，请先停止 Run");
    }
    if (current.status === BoardTaskStatus.COMPLETED) {
      throw new BoardTaskServiceError("CONFLICT", "已完成的任务不能修改");
    }
    const patch: { objective?: string; title?: string } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title === "" || title.length > DEFAULT_TITLE_MAX) {
        throw new BoardTaskServiceError("INVALID", "标题必须为 1-120 个字符");
      }
      patch.title = title;
    }
    if (input.objective !== undefined) {
      const objective = input.objective.trim();
      if (objective === "" || objective.length > MAX_OBJECTIVE_CHARS) {
        throw new BoardTaskServiceError(
          "INVALID",
          `任务目标必须为 1-${MAX_OBJECTIVE_CHARS} 个字符`,
        );
      }
      patch.objective = objective;
    }
    this.options.database.updateBoardTask(id, patch);
    return this.toView(this.requireTask(id));
  }

  public async remove(id: string): Promise<void> {
    const record = this.requireTask(id);
    const current = await this.toView(record);
    if (current.status === BoardTaskStatus.IN_PROGRESS) {
      throw new BoardTaskServiceError("BUSY", "运行中的任务不能删除");
    }
    this.options.database.archiveBoardTask(id);
  }

  public async start(id: string): Promise<{
    runId: string;
    sessionId: string;
    task: BoardTaskView;
  }> {
    if (this.startingTasks.has(id)) {
      throw new BoardTaskServiceError("BUSY", "任务正在启动，请稍后重试");
    }
    this.startingTasks.add(id);
    try {
      return await this.startReserved(id);
    } finally {
      this.startingTasks.delete(id);
    }
  }

  private async startReserved(id: string): Promise<{
    runId: string;
    sessionId: string;
    task: BoardTaskView;
  }> {
    const record = this.requireTask(id);
    const current = await this.toView(record);
    if (current.status === BoardTaskStatus.IN_PROGRESS) {
      throw new BoardTaskServiceError("BUSY", "任务已经在运行");
    }
    if (current.status === BoardTaskStatus.COMPLETED) {
      throw new BoardTaskServiceError("CONFLICT", "已完成的任务不能重新开始");
    }
    if (current.status === BoardTaskStatus.CONFIRMATION) {
      throw new BoardTaskServiceError("CONFLICT", "任务已完成，请先确认或新建任务");
    }

    let sessionId = record.sessionId;
    if (sessionId !== null) {
      try {
        const session = this.options.sessions.getSession(sessionId);
        if (session.archivedAt !== null) sessionId = null;
        else {
          const snapshot = await this.options.sessions.getSnapshot(sessionId);
          if (snapshot.isRunning) {
            throw new BoardTaskServiceError("BUSY", "关联的 Session 仍在运行");
          }
        }
      } catch (error: unknown) {
        if (error instanceof BoardTaskServiceError) throw error;
        sessionId = null;
      }
    }

    if (sessionId === null) {
      const session = await this.options.sessions.createSession({
        title: record.title,
        workspaceRoot: record.workspaceRoot,
      });
      sessionId = session.id;
    }

    const started = await this.options.sessions.startRun(sessionId, record.objective);
    if (started.runId === undefined) {
      throw new BoardTaskServiceError("BUSY", "任务已进入运行队列，请稍后重试");
    }
    this.options.database.updateBoardTask(id, {
      completedAt: null,
      rootRunId: started.runId,
      sessionId,
      status: BoardTaskStatus.IN_PROGRESS,
    });
    return {
      runId: started.runId,
      sessionId,
      task: await this.toView(this.requireTask(id)),
    };
  }

  public async confirm(id: string): Promise<BoardTaskView> {
    const record = this.requireTask(id);
    if (record.status === BoardTaskStatus.COMPLETED) return this.toView(record);
    const current = await this.toView(record);
    if (current.status !== BoardTaskStatus.CONFIRMATION) {
      throw new BoardTaskServiceError(
        "CONFLICT",
        "只有待确认的任务可以确认完成；请先等待 Run 成功结束",
      );
    }
    this.options.database.updateBoardTask(id, {
      completedAt: Date.now(),
      status: BoardTaskStatus.COMPLETED,
    });
    return this.toView(this.requireTask(id));
  }

  public async workspaces(): Promise<BoardTaskWorkspace[]> {
    const roots = new Set<string>([this.options.config.workspaceRoot]);
    for (const session of this.options.database.listSessions(true)) {
      roots.add(session.workspaceRoot);
    }
    return [...roots]
      .map((root) => ({ name: basename(root) || root, root }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async toView(record: BoardTaskRecord): Promise<BoardTaskView> {
    const base: BoardTaskView = {
      attentionReason: null,
      completedAt: record.completedAt,
      createdAt: record.createdAt,
      currentStep: null,
      fileChangeCount: 0,
      id: record.id,
      objective: record.objective,
      progress: null,
      rootRunId: record.rootRunId,
      sessionId: record.sessionId,
      status: record.status,
      title: record.title,
      updatedAt: record.updatedAt,
      workspaceName: basename(record.workspaceRoot) || record.workspaceRoot,
      workspaceRoot: record.workspaceRoot,
    };
    if (record.status === BoardTaskStatus.COMPLETED || record.completedAt !== null) {
      return { ...base, status: BoardTaskStatus.COMPLETED };
    }
    if (record.sessionId === null || record.rootRunId === null) return base;

    let events: HarnessEvent[];
    try {
      events = (await this.options.events.read(record.sessionId)).filter(
        (event) => event.runId === record.rootRunId,
      );
    } catch {
      return base;
    }
    if (events.length === 0) return base;

    const pendingApprovals = new Map<string, string>();
    let terminal: HarnessEvent | null = null;
    let sawRunStart = false;
    let todos: TodoItem[] = [];
    const changedPaths = new Set<string>();

    for (const event of events) {
      if (event.type === HarnessEventType.RUN_STARTED) sawRunStart = true;
      if (event.type === HarnessEventType.APPROVAL_REQUESTED && isRecord(event.data)) {
        const approvalId = readString(event.data, "approvalId");
        if (approvalId !== null) {
          pendingApprovals.set(approvalId, readString(event.data, "summary") ?? "需要批准一项操作");
        }
      }
      if (event.type === HarnessEventType.APPROVAL_RESOLVED && isRecord(event.data)) {
        const approvalId = readString(event.data, "approvalId");
        if (approvalId !== null) pendingApprovals.delete(approvalId);
      }
      if (
        event.type === HarnessEventType.RUN_COMPLETED ||
        event.type === HarnessEventType.RUN_FAILED ||
        event.type === HarnessEventType.RUN_ABORTED
      ) {
        terminal = event;
      }
      if (event.type === HarnessEventType.TODOS_UPDATED && isRecord(event.data)) {
        const value = event.data.todos;
        if (Array.isArray(value)) todos = value.filter(isTodoItem);
      }
      if (event.type === HarnessEventType.FILE_CHANGED && isRecord(event.data)) {
        const path = readString(event.data, "path");
        if (path !== null) changedPaths.add(path);
      }
    }

    const progress = deriveProgress(todos);
    const currentStep = deriveCurrentStep(todos);
    const attention = [...pendingApprovals.values()].at(-1) ?? failureMessage(terminal);
    let status: BoardTaskStatus;
    if (pendingApprovals.size > 0) status = BoardTaskStatus.WAITING;
    else if (terminal?.type === HarnessEventType.RUN_FAILED) status = BoardTaskStatus.WAITING;
    else if (terminal?.type === HarnessEventType.RUN_ABORTED) status = BoardTaskStatus.WAITING;
    else if (terminal?.type === HarnessEventType.RUN_COMPLETED)
      status = BoardTaskStatus.CONFIRMATION;
    else if (sawRunStart) status = BoardTaskStatus.IN_PROGRESS;
    else status = record.status;

    if (status !== record.status) {
      this.options.database.updateBoardTask(record.id, { status });
    }
    return {
      ...base,
      attentionReason: attention,
      currentStep,
      fileChangeCount: changedPaths.size,
      progress,
      status,
      updatedAt: Math.max(record.updatedAt, events.at(-1)?.timestamp ?? 0),
    };
  }

  private requireTask(id: string): BoardTaskRecord {
    const record = this.options.database.getBoardTask(id);
    if (record === null || record.archivedAt !== null) {
      throw new BoardTaskServiceError("NOT_FOUND", "任务不存在");
    }
    return record;
  }

  private async resolveWorkspace(requested: string | undefined): Promise<string> {
    if (requested === undefined || requested.trim() === "") {
      await mkdir(this.options.config.workspaceRoot, { recursive: true });
      return realpath(this.options.config.workspaceRoot);
    }
    try {
      const resolved = await realpath(resolve(requested));
      if (!(await stat(resolved)).isDirectory()) throw new Error("不是目录");
      return resolved;
    } catch {
      throw new BoardTaskServiceError("INVALID", "workspace 目录不存在或无法访问");
    }
  }
}

function deriveProgress(todos: readonly TodoItem[]): BoardTaskProgress | null {
  if (todos.length === 0) return null;
  return {
    completed: todos.filter((todo) => todo.status === "completed").length,
    total: todos.length,
  };
}

function deriveCurrentStep(todos: readonly TodoItem[]): string | null {
  return (
    todos.find((todo) => todo.status === "in_progress")?.content ??
    todos.find((todo) => todo.status === "blocked")?.content ??
    todos.find((todo) => todo.status === "pending")?.content ??
    null
  );
}

function failureMessage(terminal: HarnessEvent | null): string | null {
  if (terminal === null) return null;
  if (
    terminal.type !== HarnessEventType.RUN_FAILED &&
    terminal.type !== HarnessEventType.RUN_ABORTED
  ) {
    return null;
  }
  return isRecord(terminal.data)
    ? (readString(terminal.data, "message") ?? "任务失败")
    : "任务失败";
}

function isTodoItem(value: unknown): value is TodoItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.content === "string" &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "completed" ||
      value.status === "blocked")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const item = value[key];
  return typeof item === "string" && item !== "" ? item : null;
}
