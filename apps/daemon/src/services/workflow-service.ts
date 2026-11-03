import { randomBytes, randomUUID } from "node:crypto";
import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { CronExpressionParser } from "cron-parser";
import type { HarnessDatabase, SessionRecord, WorkflowRecord } from "../storage/database";
import type { SessionController, WorkflowNodeSpec } from "./session-types";

const MAX_NODES = 12;
const MAX_DEPENDENCIES = 8;
const MAX_TASK = 20_000;

export type WorkflowServiceErrorCode = "INVALID" | "NOT_FOUND";

export class WorkflowServiceError extends Error {
  public constructor(
    public readonly code: WorkflowServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowServiceError";
  }
}

export type TriggerCondition =
  | { type: "always" }
  | { type: "fileMatches"; value: string }
  | { type: "webhookContains"; value: string };

export interface WorkflowView {
  createdAt: number;
  fileWatchEnabled: boolean;
  fileWatchPaths: string[];
  id: string;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  nextRunAt: number | null;
  nodes: WorkflowNodeSpec[];
  scheduleCron: string | null;
  scheduleIntervalMinutes: number | null;
  scheduleTimezone: string | null;
  title: string;
  triggerCondition: TriggerCondition;
  updatedAt: number;
  webhookToken: string | null;
}

export interface WorkflowRunView {
  endedAt: number | null;
  id: string;
  runId: string;
  sessionId: string;
  startedAt: number;
  status: "aborted" | "completed" | "failed" | "running";
}

export class WorkflowService {
  public constructor(
    private readonly options: {
      database: HarnessDatabase;
      sessions: SessionController;
    },
  ) {}

  public list(): WorkflowView[] {
    return this.options.database.listWorkflows().map(toView);
  }

  public get(id: string): WorkflowView {
    return toView(this.requireWorkflow(id));
  }

  public create(input: {
    fileWatchEnabled?: boolean | undefined;
    fileWatchPaths?: readonly string[] | undefined;
    nodes: readonly WorkflowNodeSpec[];
    scheduleCron?: string | null | undefined;
    scheduleIntervalMinutes?: number | null | undefined;
    scheduleTimezone?: string | null | undefined;
    title: string;
    triggerCondition?: TriggerCondition | undefined;
    webhookEnabled?: boolean | undefined;
  }): WorkflowView {
    const title = normalizeTitle(input.title);
    const nodes = validateNodes(input.nodes);
    const schedule = normalizeScheduleConfig(input);
    return toView(
      this.options.database.createWorkflow({
        fileWatchEnabled: input.fileWatchEnabled === true,
        fileWatchPaths: normalizeWatchPaths(input.fileWatchPaths ?? []),
        id: randomUUID(),
        nextRunAt: schedule.nextRunAt,
        nodesJson: JSON.stringify(nodes),
        scheduleCron: schedule.cron,
        scheduleIntervalMinutes: schedule.intervalMinutes,
        scheduleTimezone: schedule.timezone,
        title,
        triggerConditionJson: JSON.stringify(normalizeCondition(input.triggerCondition)),
        webhookToken: input.webhookEnabled === true ? newToken() : null,
      }),
    );
  }

  public update(
    id: string,
    input: {
      fileWatchEnabled?: boolean | undefined;
      fileWatchPaths?: readonly string[] | undefined;
      nodes?: readonly WorkflowNodeSpec[] | undefined;
      scheduleCron?: string | null | undefined;
      scheduleIntervalMinutes?: number | null | undefined;
      scheduleTimezone?: string | null | undefined;
      title?: string | undefined;
      triggerCondition?: TriggerCondition | undefined;
      webhookEnabled?: boolean | undefined;
    },
  ): WorkflowView {
    this.requireWorkflow(id);
    const current = this.requireWorkflow(id);
    const patch: {
      fileWatchEnabled?: boolean;
      fileWatchPaths?: string[];
      nextRunAt?: number | null;
      nodesJson?: string;
      scheduleCron?: string | null;
      scheduleIntervalMinutes?: number | null;
      scheduleTimezone?: string | null;
      title?: string;
      triggerConditionJson?: string | null;
      webhookToken?: string | null;
    } = {};
    if (input.fileWatchEnabled !== undefined) {
      patch.fileWatchEnabled = input.fileWatchEnabled;
    }
    if (input.fileWatchPaths !== undefined) {
      patch.fileWatchPaths = normalizeWatchPaths(input.fileWatchPaths);
    }
    if (input.webhookEnabled !== undefined) {
      patch.webhookToken = input.webhookEnabled ? (current.webhookToken ?? newToken()) : null;
    }
    if (input.title !== undefined) patch.title = normalizeTitle(input.title);
    if (input.nodes !== undefined) {
      patch.nodesJson = JSON.stringify(validateNodes(input.nodes));
    }
    if (
      input.scheduleCron !== undefined ||
      input.scheduleIntervalMinutes !== undefined ||
      input.scheduleTimezone !== undefined
    ) {
      const schedule = normalizeScheduleConfig({
        scheduleCron: input.scheduleCron === undefined ? current.scheduleCron : input.scheduleCron,
        scheduleIntervalMinutes:
          input.scheduleIntervalMinutes === undefined
            ? current.scheduleIntervalMinutes
            : input.scheduleIntervalMinutes,
        scheduleTimezone:
          input.scheduleTimezone === undefined ? current.scheduleTimezone : input.scheduleTimezone,
      });
      patch.scheduleCron = schedule.cron;
      patch.scheduleIntervalMinutes = schedule.intervalMinutes;
      patch.scheduleTimezone = schedule.timezone;
      patch.nextRunAt = schedule.nextRunAt;
    }
    if (input.triggerCondition !== undefined) {
      patch.triggerConditionJson = JSON.stringify(normalizeCondition(input.triggerCondition));
    }
    this.options.database.updateWorkflow(id, patch);
    return this.get(id);
  }

  public delete(id: string): void {
    this.requireWorkflow(id);
    this.options.database.deleteWorkflow(id);
  }

  public async run(
    id: string,
    workspaceRoot?: string,
  ): Promise<{ runId: string; session: SessionRecord; workflow: WorkflowView }> {
    const workflow = this.get(id);
    let session: SessionRecord | null = null;
    try {
      session = await this.options.sessions.createSession({
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        title: `工作流 · ${workflow.title}`.slice(0, 120),
      });
      const { runId } = await this.options.sessions.startWorkflow(session.id, workflow.nodes);
      const startedAt = Date.now();
      this.options.database.createWorkflowRun({
        id: randomUUID(),
        runId,
        sessionId: session.id,
        startedAt,
        workflowId: id,
      });
      this.options.database.setWorkflowLastRun(id, session.id, startedAt);
      return { runId, session, workflow: this.get(id) };
    } catch (error: unknown) {
      if (session !== null) this.options.sessions.archiveSession(session.id);
      throw error;
    }
  }

  public listDue(now = Date.now()): WorkflowView[] {
    return this.list().filter(
      (workflow) =>
        workflow.scheduleIntervalMinutes !== null &&
        workflow.nextRunAt !== null &&
        workflow.nextRunAt <= now,
    );
  }

  public async runTriggered(
    id: string,
  ): Promise<{ runId: string; session: SessionRecord; workflow: WorkflowView } | null> {
    const workflow = this.get(id);
    if (workflow.lastRunSessionId !== null) {
      try {
        const snapshot = await this.options.sessions.getSnapshot(workflow.lastRunSessionId);
        if (snapshot.isRunning) return null;
      } catch {
        // 上次 Session 丢失时继续触发。
      }
    }
    return this.run(id);
  }

  public async runScheduled(
    id: string,
    now = Date.now(),
  ): Promise<{ runId: string; session: SessionRecord; workflow: WorkflowView } | null> {
    const workflow = this.get(id);
    if (workflow.scheduleCron === null && workflow.scheduleIntervalMinutes === null) {
      return null;
    }
    const nextRunAt = computeNextRun(workflow, now);
    const result = await this.runTriggered(id);
    this.options.database.updateWorkflow(id, { nextRunAt });
    return result;
  }

  public verifyWebhook(id: string, token: string): WorkflowView {
    const workflow = this.get(id);
    if (workflow.webhookToken === null || workflow.webhookToken !== token) {
      throw new WorkflowServiceError("NOT_FOUND", "Webhook 不存在或 token 无效");
    }
    return workflow;
  }

  public listFileWatchWorkflows(): WorkflowView[] {
    return this.list().filter(
      (workflow) => workflow.fileWatchEnabled && workflow.fileWatchPaths.length > 0,
    );
  }

  public async history(id: string): Promise<WorkflowRunView[]> {
    this.requireWorkflow(id);
    const runs = this.options.database.listWorkflowRuns(id);
    return Promise.all(
      runs.map(async (run) => {
        let events: HarnessEvent[] = [];
        try {
          events = await this.options.sessions.readEvents(run.sessionId, 0);
        } catch {
          // Session 丢失时按 running 展示，由调用方决定是否清理。
        }
        const relevant = events.filter((event) => event.runId === run.runId);
        const terminal = relevant.findLast(
          (event) =>
            event.type === HarnessEventType.RUN_COMPLETED ||
            event.type === HarnessEventType.RUN_FAILED ||
            event.type === HarnessEventType.RUN_ABORTED,
        );
        const status =
          terminal?.type === HarnessEventType.RUN_COMPLETED
            ? "completed"
            : terminal?.type === HarnessEventType.RUN_FAILED
              ? "failed"
              : terminal?.type === HarnessEventType.RUN_ABORTED
                ? "aborted"
                : "running";
        return {
          endedAt: terminal?.timestamp ?? null,
          id: run.id,
          runId: run.runId,
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          status,
        } satisfies WorkflowRunView;
      }),
    );
  }

  private requireWorkflow(id: string): WorkflowRecord {
    const record = this.options.database.getWorkflow(id);
    if (record === null) throw new WorkflowServiceError("NOT_FOUND", "工作流不存在");
    return record;
  }
}

function toView(record: WorkflowRecord): WorkflowView {
  return {
    createdAt: record.createdAt,
    fileWatchEnabled: record.fileWatchEnabled,
    fileWatchPaths: record.fileWatchPaths,
    id: record.id,
    lastRunAt: record.lastRunAt,
    lastRunSessionId: record.lastRunSessionId,
    nextRunAt: record.nextRunAt,
    nodes: JSON.parse(record.nodesJson) as WorkflowNodeSpec[],
    scheduleCron: record.scheduleCron,
    scheduleIntervalMinutes: record.scheduleIntervalMinutes,
    scheduleTimezone: record.scheduleTimezone,
    title: record.title,
    triggerCondition: parseCondition(record.triggerConditionJson),
    updatedAt: record.updatedAt,
    webhookToken: record.webhookToken,
  };
}

function normalizeScheduleConfig(input: {
  scheduleCron?: string | null | undefined;
  scheduleIntervalMinutes?: number | null | undefined;
  scheduleTimezone?: string | null | undefined;
}): {
  cron: string | null;
  intervalMinutes: number | null;
  nextRunAt: number | null;
  timezone: string | null;
} {
  const cron = input.scheduleCron?.trim() ?? "";
  if (cron !== "") {
    const timezone = normalizeTimezone(input.scheduleTimezone ?? "UTC");
    return {
      cron,
      intervalMinutes: null,
      nextRunAt: nextCronTime(cron, timezone, Date.now()),
      timezone,
    };
  }
  const intervalMinutes = normalizeSchedule(input.scheduleIntervalMinutes);
  return {
    cron: null,
    intervalMinutes,
    nextRunAt: intervalMinutes === null ? null : Date.now() + intervalMinutes * 60_000,
    timezone: null,
  };
}

function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (timezone === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    throw new WorkflowServiceError("INVALID", `无效时区: ${timezone}`);
  }
}

function nextCronTime(cron: string, timezone: string, now: number): number {
  try {
    return CronExpressionParser.parse(cron, {
      currentDate: new Date(now),
      tz: timezone,
    })
      .next()
      .getTime();
  } catch {
    throw new WorkflowServiceError("INVALID", `无效 cron 表达式: ${cron}`);
  }
}

function computeNextRun(workflow: WorkflowView, now: number): number | null {
  if (workflow.scheduleCron !== null) {
    return nextCronTime(workflow.scheduleCron, workflow.scheduleTimezone ?? "UTC", now);
  }
  if (workflow.scheduleIntervalMinutes !== null) {
    return now + workflow.scheduleIntervalMinutes * 60_000;
  }
  return null;
}

function normalizeCondition(value: TriggerCondition | undefined): TriggerCondition {
  if (value === undefined || value.type === "always") return { type: "always" };
  const conditionValue = value.value.trim();
  if (conditionValue === "") {
    throw new WorkflowServiceError("INVALID", "触发条件不能为空");
  }
  return { type: value.type, value: conditionValue };
}

function parseCondition(value: string | null): TriggerCondition {
  if (value === null) return { type: "always" };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "type" in parsed
    ) {
      const condition = parsed as { type?: unknown; value?: unknown };
      if (condition.type === "always") return { type: "always" };
      if (
        (condition.type === "fileMatches" || condition.type === "webhookContains") &&
        typeof condition.value === "string" &&
        condition.value !== ""
      ) {
        return { type: condition.type, value: condition.value };
      }
    }
  } catch {
    // 坏配置降级为 always。
  }
  return { type: "always" };
}

export function matchesTriggerCondition(
  condition: TriggerCondition,
  input: { kind: "file" | "webhook"; value: string },
): boolean {
  if (condition.type === "always") return true;
  if (condition.type === "webhookContains") {
    return input.kind === "webhook" && input.value.includes(condition.value);
  }
  return input.kind === "file" && globMatches(condition.value, input.value);
}

function globMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.split("\\").join("/");
  const special = "^$+?.()|{}[]";
  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character !== undefined && special.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character ?? "";
    }
  }
  try {
    return new RegExp(`^${source}$`, "u").test(value.split("\\").join("/"));
  } catch {
    return false;
  }
}

function newToken(): string {
  return randomBytes(24).toString("hex");
}

function normalizeWatchPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map((path) => path.trim()).filter((path) => path !== ""))];
  if (unique.length > 16) {
    throw new WorkflowServiceError("INVALID", "文件监听路径最多 16 个");
  }
  for (const path of unique) {
    if (path.startsWith("/") || path.startsWith("\\") || path.split(/[/]/u).includes("..")) {
      throw new WorkflowServiceError("INVALID", "文件监听路径必须是 workspace 内的相对路径");
    }
  }
  return unique;
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title === "" || title.length > 120) {
    throw new WorkflowServiceError("INVALID", "工作流标题必须为 1-120 个字符");
  }
  return title;
}

export function validateNodes(nodes: readonly WorkflowNodeSpec[]): WorkflowNodeSpec[] {
  if (nodes.length === 0 || nodes.length > MAX_NODES) {
    throw new WorkflowServiceError("INVALID", `工作流节点数必须为 1-${MAX_NODES}`);
  }
  const ids = new Set<string>();
  const normalized = nodes.map((node) => {
    const id = node.id.trim();
    const task = node.task.trim();
    const title = node.title?.trim();
    if (id === "" || id.length > 64) {
      throw new WorkflowServiceError("INVALID", "节点 id 必须为 1-64 个字符");
    }
    if (ids.has(id)) throw new WorkflowServiceError("INVALID", `节点 id 重复: ${id}`);
    ids.add(id);
    if (task === "" || task.length > MAX_TASK) {
      throw new WorkflowServiceError("INVALID", `节点 ${id} 的任务必须为 1-${MAX_TASK} 个字符`);
    }
    const dependsOn = [...(node.dependsOn ?? [])];
    if (dependsOn.length > MAX_DEPENDENCIES) {
      throw new WorkflowServiceError("INVALID", `节点 ${id} 依赖不能超过 ${MAX_DEPENDENCIES} 个`);
    }
    return {
      ...(node.agentType === undefined ? {} : { agentType: node.agentType }),
      dependsOn,
      id,
      task,
      ...(title === undefined || title === "" ? {} : { title }),
    } satisfies WorkflowNodeSpec;
  });

  const byId = new Map(normalized.map((node) => [node.id, node]));
  for (const node of normalized) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.id) {
        throw new WorkflowServiceError("INVALID", `节点 ${node.id} 不能依赖自己`);
      }
      if (!byId.has(dependency)) {
        throw new WorkflowServiceError("INVALID", `节点 ${node.id} 依赖不存在: ${dependency}`);
      }
    }
  }
  if (hasCycle(normalized)) {
    throw new WorkflowServiceError("INVALID", "工作流依赖存在环");
  }
  return normalized;
}

function hasCycle(nodes: readonly WorkflowNodeSpec[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function normalizeSchedule(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 10_080) {
    throw new WorkflowServiceError("INVALID", "调度间隔必须为 1-10080 分钟");
  }
  return value;
}
