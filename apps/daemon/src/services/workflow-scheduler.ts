import type { WorkflowService } from "./workflow-service";

export class WorkflowScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(
    private readonly options: {
      intervalMs?: number;
      logger: {
        error(details: Record<string, unknown>, message: string): void;
        warn(details: Record<string, unknown>, message: string): void;
      };
      now?: () => number;
      service: WorkflowService;
    },
  ) {}

  public start(): void {
    if (this.timer !== null) return;
    const interval = this.options.intervalMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  public async tick(now = this.options.now?.() ?? Date.now()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      for (const workflow of this.options.service.listDue(now)) {
        try {
          const result = await this.options.service.runScheduled(workflow.id, now);
          if (result !== null) started += 1;
        } catch (error: unknown) {
          this.options.logger.error({ err: error, workflowId: workflow.id }, "定时工作流启动失败");
          this.options.logger.warn(
            { workflowId: workflow.id },
            "定时工作流保留在 due 列表，下一轮会重试",
          );
        }
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }
}
