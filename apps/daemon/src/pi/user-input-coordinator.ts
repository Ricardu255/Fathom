import { randomUUID } from "node:crypto";
import {
  HarnessEventType,
  type UserInputAnswer,
  type UserInputQuestion,
  type UserInputRequestedData,
} from "@harness/core";
import type { PiBridgeEmit } from "./event-bridge";

const DEFAULT_TIMEOUT_MS = 300_000;

interface PendingInput {
  executionId: string | undefined;
  inputId: string;
  questions: UserInputQuestion[];
  reject: (error: Error) => void;
  resolve: (answers: UserInputAnswer[]) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class UserInputError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "UserInputError";
  }
}

/** 一个 Run 内可同时存在多个等待回答的提问；按 inputId 一次性解决。 */
export class UserInputCoordinator {
  private readonly pending = new Map<string, PendingInput>();

  public constructor(
    private readonly emit: PiBridgeEmit,
    private readonly getRunId: () => string | null,
  ) {}

  public async request(
    input: Omit<UserInputRequestedData, "inputId">,
    signal: AbortSignal | undefined,
  ): Promise<UserInputAnswer[]> {
    const inputId = randomUUID();
    if (input.questions.length === 0) throw new UserInputError("INVALID", "问题不能为空");
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000), 1_800_000);
    let resolvePromise: (answers: UserInputAnswer[]) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const result = new Promise<UserInputAnswer[]>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timeout = setTimeout(() => {
      const current = this.pending.get(inputId);
      if (current === undefined) return;
      this.pending.delete(inputId);
      void this.expire(current, "timeout");
      rejectPromise(new Error("等待用户回答超时"));
    }, timeoutMs);
    const pending: PendingInput = {
      executionId: input.executionId,
      inputId,
      questions: input.questions,
      reject: rejectPromise,
      resolve: resolvePromise,
      timeout,
    };
    this.pending.set(inputId, pending);
    const onAbort = () => {
      const current = this.pending.get(inputId);
      if (current === undefined) return;
      this.pending.delete(inputId);
      clearTimeout(current.timeout);
      void this.expire(current, "aborted");
      rejectPromise(new Error("用户输入等待已中止"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      try {
        await this.emit({
          data: { ...input, inputId, timeoutMs },
          runId: this.getRunId(),
          type: HarnessEventType.INPUT_REQUESTED,
        });
      } catch {
        this.pending.delete(inputId);
        clearTimeout(timeout);
        throw new Error("无法发送提问");
      }
      return await result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(inputId);
      clearTimeout(timeout);
    }
  }

  public async resolve(inputId: string, answers: readonly UserInputAnswer[]): Promise<boolean> {
    const pending = this.pending.get(inputId);
    if (pending === undefined) return false;
    const validated = validateAnswers(pending.questions, answers);
    if (validated === null) throw new UserInputError("INVALID", "回答不完整或选项无效");
    this.pending.delete(inputId);
    clearTimeout(pending.timeout);
    await this.emit({
      data: {
        answers: validated,
        ...(pending.executionId === undefined ? {} : { executionId: pending.executionId }),
        inputId,
      },
      runId: this.getRunId(),
      type: HarnessEventType.INPUT_RESOLVED,
    });
    pending.resolve(validated);
    return true;
  }

  public cancelAll(): void {
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(pending.inputId);
      clearTimeout(pending.timeout);
      void this.expire(pending, "aborted");
      pending.reject(new Error("用户输入等待已中止"));
    }
  }

  private async expire(pending: PendingInput, reason: "aborted" | "timeout"): Promise<void> {
    try {
      await this.emit({
        data: {
          ...(pending.executionId === undefined ? {} : { executionId: pending.executionId }),
          inputId: pending.inputId,
          reason,
        },
        runId: this.getRunId(),
        type: HarnessEventType.INPUT_EXPIRED,
      });
    } catch {
      // 过期通知失败不能阻塞 Run 收尾。
    }
  }
}

function validateAnswers(
  questions: readonly UserInputQuestion[],
  answers: readonly UserInputAnswer[],
): UserInputAnswer[] | null {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const normalized: UserInputAnswer[] = [];
  for (const question of questions) {
    const answer = byId.get(question.id);
    if (answer === undefined || answer.value.trim() === "") return null;
    if (question.multiSelect) {
      const selected = answer.selectedOptions ?? [];
      if (
        selected.length === 0 ||
        selected.some((id) => !question.options.some((o) => o.id === id))
      ) {
        return null;
      }
      normalized.push({ ...answer, selectedOptions: selected });
    } else {
      if (
        answer.selectedOption !== undefined &&
        !question.options.some((option) => option.id === answer.selectedOption)
      ) {
        return null;
      }
      normalized.push(answer);
    }
  }
  return normalized;
}
