import type { ModelClient } from "@harness/core";
import { AnthropicModelClient } from "./anthropic";
import { MockModelClient } from "./mock";

export { AnthropicModelClient } from "./anthropic";
export { MockModelClient } from "./mock";

export interface ModelClientConfig {
  apiKey?: string;
  mock: boolean;
}

/** 没有 Key 或显式开启 mock 时使用本地演示模型，避免首次启动被外部依赖阻塞。 */
export function createModelClient(config: ModelClientConfig): ModelClient {
  if (config.mock || config.apiKey === undefined || config.apiKey.trim() === "") {
    return new MockModelClient();
  }
  return new AnthropicModelClient({ apiKey: config.apiKey });
}
