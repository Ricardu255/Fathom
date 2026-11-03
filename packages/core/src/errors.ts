export type ModelErrorCode =
  | "AUTH"
  | "CONTEXT_OVERFLOW"
  | "NETWORK"
  | "OVERLOADED"
  | "PROVIDER"
  | "RATE_LIMIT"
  | "UNKNOWN";

/**
 * Provider 适配层抛出的可分类错误。
 * Agent 循环只根据 code/retryable 决定是否重试与如何展示，不依赖具体 SDK 异常类型。
 */
export class ModelClientError extends Error {
  public readonly retryable: boolean;
  public readonly status: number | undefined;

  public constructor(
    public readonly code: ModelErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelClientError";
    this.retryable = code === "RATE_LIMIT" || code === "OVERLOADED" || code === "NETWORK";
    this.status = options.status;
  }
}

export function isModelClientError(error: unknown): error is ModelClientError {
  return error instanceof ModelClientError;
}
