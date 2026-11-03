import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveWorkspacePath } from "@harness/policy";
import {
  matchesTriggerCondition,
  type TriggerCondition,
  type WorkflowService,
} from "./workflow-service";

interface WatchedWorkflow {
  condition: TriggerCondition;
  paths: string[];
  timer: NodeJS.Timeout | null;
  watchers: FSWatcher[];
}

export class WorkflowFileWatcher {
  private readonly watched = new Map<string, WatchedWorkflow>();
  private reconcileTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly options: {
      debounceMs?: number;
      logger: {
        error(details: Record<string, unknown>, message: string): void;
        warn(details: Record<string, unknown>, message: string): void;
      };
      service: WorkflowService;
      workspaceRoot: string;
    },
  ) {}

  public start(): void {
    if (this.reconcileTimer !== null) return;
    void this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, 10_000);
    this.reconcileTimer.unref();
  }

  public stop(): void {
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const entry of this.watched.values()) this.close(entry);
    this.watched.clear();
  }

  public async reconcile(): Promise<void> {
    const desired = this.options.service.listFileWatchWorkflows();
    const desiredIds = new Set(desired.map((workflow) => workflow.id));

    for (const [id, entry] of this.watched) {
      if (!desiredIds.has(id)) {
        this.close(entry);
        this.watched.delete(id);
      }
    }

    for (const workflow of desired) {
      const signature = JSON.stringify(workflow.fileWatchPaths);
      const existing = this.watched.get(workflow.id);
      if (existing !== undefined && JSON.stringify(existing.paths) === signature) continue;
      if (existing !== undefined) this.close(existing);
      const entry: WatchedWorkflow = {
        condition: workflow.triggerCondition,
        paths: [...workflow.fileWatchPaths],
        timer: null,
        watchers: [],
      };
      for (const path of workflow.fileWatchPaths) {
        try {
          const absolute = await resolveWorkspacePath({
            path,
            workspaceRoot: this.options.workspaceRoot,
          });
          const info = await stat(absolute);
          const watcher = watch(
            absolute,
            { persistent: false, recursive: info.isDirectory() },
            (_event, filename) => {
              const changedPath =
                filename === null || filename === undefined
                  ? path
                  : filename.toString().split("\\").join("/");
              this.schedule(workflow.id, entry, changedPath);
            },
          );
          watcher.on("error", (error) => {
            this.options.logger.warn(
              { err: error, path, workflowId: workflow.id },
              "工作流文件监听失败",
            );
          });
          entry.watchers.push(watcher);
        } catch (error: unknown) {
          this.options.logger.warn(
            { err: error, path, workflowId: workflow.id },
            "无法监听工作流路径",
          );
        }
      }
      this.watched.set(workflow.id, entry);
    }
  }

  private schedule(workflowId: string, entry: WatchedWorkflow, changedPath: string): void {
    if (
      !matchesTriggerCondition(entry.condition, {
        kind: "file",
        value: changedPath,
      })
    ) {
      return;
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.trigger(workflowId);
    }, this.options.debounceMs ?? 1_500);
    entry.timer.unref();
  }

  private async trigger(workflowId: string): Promise<void> {
    try {
      const result = await this.options.service.runTriggered(workflowId);
      if (result !== null) {
        this.options.logger.warn(
          { sessionId: result.session.id, workflowId },
          "文件变更触发工作流",
        );
      }
    } catch (error: unknown) {
      this.options.logger.error({ err: error, workflowId }, "文件变更工作流启动失败");
    }
  }

  private close(entry: WatchedWorkflow): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
  }
}
