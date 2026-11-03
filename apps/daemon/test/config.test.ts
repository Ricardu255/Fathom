import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config";

test("显式关闭 Mock 但缺少 Key 时仍能启动，以便在设置页补配置", () => {
  const config = loadConfig({
    HARNESS_MOCK_MODEL: "0",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(config.mockModel, false);
  assert.equal(config.anthropicApiKey, undefined);
});

test("子 Agent 预算默认不限制 token，时长/节点沿用安全默认值", () => {
  const config = loadConfig({
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(config.subAgentMaxTokens, 0);
  assert.equal(config.subAgentRunMaxTokens, 0);
  assert.equal(config.subAgentRunMaxDurationMs, 0);
  assert.equal(config.subAgentMaxDurationMs, 600_000);
  assert.equal(config.subAgentMaxTotal, 12);
  assert.equal(config.subAgentMaxDagNodes, 12);
});

test("SearXNG 地址可选，未配置时保持 undefined", () => {
  const defaults = loadConfig({
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(defaults.searxngUrl, undefined);
  const configured = loadConfig({
    HARNESS_MOCK_MODEL: "1",
    HARNESS_SEARXNG_URL: "http://127.0.0.1:8888",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(configured.searxngUrl, "http://127.0.0.1:8888");
});

test("自动续轮默认 8 次，可用环境变量关闭或覆盖", () => {
  const defaults = loadConfig({
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(defaults.autoFollowUpMax, 8);
  const overridden = loadConfig({
    HARNESS_AUTO_FOLLOW_UP_MAX: "3",
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(overridden.autoFollowUpMax, 3);
  const disabled = loadConfig({
    HARNESS_AUTO_FOLLOW_UP_MAX: "0",
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(disabled.autoFollowUpMax, 0);
});

test("子 Agent 预算可以从环境变量覆盖", () => {
  const config = loadConfig({
    HARNESS_MOCK_MODEL: "1",
    HARNESS_SUBAGENT_MAX_DAG_NODES: "4",
    HARNESS_SUBAGENT_MAX_DURATION_MS: "5000",
    HARNESS_SUBAGENT_MAX_TOKENS: "1200",
    HARNESS_SUBAGENT_MAX_TOTAL: "3",
    HARNESS_SUBAGENT_RUN_MAX_DURATION_MS: "9000",
    HARNESS_SUBAGENT_RUN_MAX_TOKENS: "5000",
    HARNESS_WORKSPACE: "./workspace",
  });
  assert.equal(config.subAgentMaxTokens, 1_200);
  assert.equal(config.subAgentRunMaxTokens, 5_000);
  assert.equal(config.subAgentMaxDurationMs, 5_000);
  assert.equal(config.subAgentRunMaxDurationMs, 9_000);
  assert.equal(config.subAgentMaxTotal, 3);
  assert.equal(config.subAgentMaxDagNodes, 4);
});
