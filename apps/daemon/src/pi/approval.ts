import { randomUUID } from "node:crypto";
import { HarnessEventType } from "@harness/core";
import type { ApprovalMode } from "../storage/database";
import type { PiBridgeEmit } from "./event-bridge";
import type { PiToolApprovalInput } from "./tools";

const HIGH_RISK_TOOLS = new Set(["run_command", "start_background_command"]);

interface PendingApproval {
  grantKey: string;
  prefixRule: string | undefined;
  resolve: (approved: boolean) => void;
}

/** pi 没有内置权限系统；审批在我们的自定义工具包装层完成。 */
export class PiApprovalCoordinator {
  private readonly grants = new Set<string>();
  private readonly pending = new Map<string, PendingApproval>();

  public constructor(
    private readonly emit: PiBridgeEmit,
    private readonly getRunId: () => string | null,
    private readonly approvalMode: () => ApprovalMode,
    private readonly reviewHighRisk?: (
      input: PiToolApprovalInput,
      signal: AbortSignal | undefined,
    ) => Promise<boolean>,
    private readonly grantPrefix?: (prefix: string) => void,
  ) {}

  public async request(
    input: PiToolApprovalInput,
    signal: AbortSignal | undefined,
    executionId?: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const grantKey = `${input.toolName}:${input.target ?? input.summary}`;
    if (options.force !== true) {
      const mode = this.approvalMode();
      if (mode === "full_access") return true;
      if (this.grants.has(grantKey)) return true;
      if (mode === "auto_approve") {
        if (!HIGH_RISK_TOOLS.has(input.toolName)) return true;
        const reviewed =
          this.reviewHighRisk === undefined
            ? false
            : await this.reviewHighRisk(input, signal).catch(() => false);
        if (reviewed) return true;
        if (signal?.aborted === true) return false;
      }
    }
    if (signal?.aborted === true) return false;
    const approvalId = randomUUID();
    let resolveDecision: (approved: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
      this.pending.set(approvalId, {
        grantKey,
        prefixRule: input.prefixRule,
        resolve,
      });
    });
    const onAbort = () => {
      this.pending.delete(approvalId);
      resolveDecision(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      try {
        await this.emit({
          data: {
            approvalId,
            ...(input.consequence === undefined ? {} : { consequence: input.consequence }),
            ...(executionId === undefined ? {} : { executionId }),
            input: input.input,
            ...(input.prefixRule === undefined ? {} : { prefixRule: input.prefixRule }),
            ...(input.risk === undefined ? {} : { risk: input.risk }),
            summary: input.summary,
            ...(input.target === undefined ? {} : { target: input.target }),
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          },
          runId: this.getRunId(),
          type: HarnessEventType.APPROVAL_REQUESTED,
        });
      } catch {
        return false;
      }
      const approved = await decision;
      try {
        await this.emit({
          data: {
            approvalId,
            decision: approved ? "approved" : "denied",
            ...(executionId === undefined ? {} : { executionId }),
          },
          runId: this.getRunId(),
          type: HarnessEventType.APPROVAL_RESOLVED,
        });
      } catch {
        // 事件写入失败不应改变用户已经做出的决定。
      }
      return approved;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(approvalId);
    }
  }

  public resolve(
    approvalId: string,
    approved: boolean,
    options: { allowPrefix?: string; grantSession?: boolean } = {},
  ): boolean {
    const pending = this.pending.get(approvalId);
    if (pending === undefined) return false;
    if (approved && options.grantSession === true) {
      this.grants.add(pending.grantKey);
    }
    if (
      approved &&
      options.allowPrefix !== undefined &&
      pending.prefixRule !== undefined &&
      options.allowPrefix === pending.prefixRule
    ) {
      this.grantPrefix?.(options.allowPrefix);
    }
    this.pending.delete(approvalId);
    pending.resolve(approved);
    return true;
  }

  public cancelAll(): void {
    for (const pending of this.pending.values()) pending.resolve(false);
    this.pending.clear();
  }
}
