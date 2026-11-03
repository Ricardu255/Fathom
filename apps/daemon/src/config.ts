import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const EnvironmentSchema = z.object({
  HARNESS_ANTHROPIC_API_KEY: optionalString,
  HARNESS_AUTO_FOLLOW_UP_MAX: optionalString,
  HARNESS_DATA_DIR: optionalString,
  HARNESS_EMBEDDING_API_KEY: optionalString,
  HARNESS_EMBEDDING_DIMENSIONS: optionalString,
  HARNESS_EMBEDDING_MODEL: optionalString,
  HARNESS_EMBEDDING_URL: optionalString,
  HARNESS_ENGINE: optionalString,
  HARNESS_HOST: optionalString,
  HARNESS_MAX_TOKENS: optionalString,
  HARNESS_MOCK_MODEL: optionalString,
  HARNESS_MODEL: optionalString,
  HARNESS_PORT: optionalString,
  HARNESS_SANDBOX_CREDENTIAL_NAMES: optionalString,
  HARNESS_SEARXNG_URL: optionalString,
  HARNESS_SUBAGENT_MAX_DAG_NODES: optionalString,
  HARNESS_SUBAGENT_MAX_DURATION_MS: optionalString,
  HARNESS_SUBAGENT_MAX_TOKENS: optionalString,
  HARNESS_SUBAGENT_MAX_TOTAL: optionalString,
  HARNESS_SUBAGENT_RUN_MAX_DURATION_MS: optionalString,
  HARNESS_SUBAGENT_RUN_MAX_TOKENS: optionalString,
  HARNESS_WEB_DIST: optionalString,
  HARNESS_WEB_ORIGIN: optionalString,
  HARNESS_WORKSPACE: optionalString,
});

export type HarnessEngine = "builtin" | "pi";

export interface HarnessConfig {
  anthropicApiKey: string | undefined;
  autoFollowUpMax: number;
  dataDir: string;
  embeddingApiKey: string | undefined;
  embeddingDimensions: number;
  embeddingModel: string;
  embeddingUrl: string | undefined;
  engine: HarnessEngine;
  host: string;
  literatureDir: string;
  maxTokens: number;
  mockModel: boolean;
  model: string;
  piAgentDir: string;
  piSessionsDir: string;
  port: number;
  repoRoot: string;
  sandboxCredentialNames: string[];
  searxngUrl: string | undefined;
  sessionsDir: string;
  skillsGlobalDir: string;
  skillsSystemDir: string;
  subAgentMaxDagNodes: number;
  subAgentMaxDurationMs: number;
  subAgentMaxTokens: number;
  subAgentMaxTotal: number;
  subAgentRunMaxDurationMs: number;
  subAgentRunMaxTokens: number;
  webDistPath: string;
  webOrigin: string;
  workspaceRoot: string;
}

/** 只接受回环监听；需要远程访问时应在前面加带认证的反向代理，而不是放开这里。 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(
      `环境变量格式无效: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  const env = parsed.data;
  const host = env.HARNESS_HOST ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("HARNESS_HOST 必须是回环地址（127.0.0.1、localhost 或 ::1）");
  }

  const port = parseInteger(env.HARNESS_PORT ?? "4311", "HARNESS_PORT", 1, 65_535);
  const webOrigin = parseOrigin(env.HARNESS_WEB_ORIGIN ?? "http://127.0.0.1:5180");
  const engine = env.HARNESS_ENGINE ?? "pi";
  if (engine !== "pi" && engine !== "builtin") {
    throw new Error("HARNESS_ENGINE 必须是 pi 或 builtin");
  }
  const dataDir = resolvePath(env.HARNESS_DATA_DIR ?? "data");
  const workspaceRoot = resolvePath(env.HARNESS_WORKSPACE ?? "workspace");
  const apiKey = env.HARNESS_ANTHROPIC_API_KEY;
  // 不在 loadConfig 阶段因缺少 Key 退出：Key 可能已经保存在设置数据库里，
  // 由 readStoredModelSelection 在打开数据库后决定是否回退 Mock。
  const mockModel =
    env.HARNESS_MOCK_MODEL === "1" ||
    (env.HARNESS_MOCK_MODEL === undefined && apiKey === undefined);

  return {
    anthropicApiKey: apiKey,
    autoFollowUpMax: parseNonNegativeInteger(
      env.HARNESS_AUTO_FOLLOW_UP_MAX ?? "8",
      "HARNESS_AUTO_FOLLOW_UP_MAX",
      0,
      32,
    ),
    dataDir,
    embeddingApiKey: env.HARNESS_EMBEDDING_API_KEY,
    embeddingDimensions: parseInteger(
      env.HARNESS_EMBEDDING_DIMENSIONS ?? "1536",
      "HARNESS_EMBEDDING_DIMENSIONS",
      1,
      16_384,
    ),
    embeddingModel: env.HARNESS_EMBEDDING_MODEL ?? "text-embedding-3-small",
    embeddingUrl: env.HARNESS_EMBEDDING_URL,
    engine,
    host,
    literatureDir: resolve(dataDir, "literature"),
    maxTokens: parseInteger(env.HARNESS_MAX_TOKENS ?? "16000", "HARNESS_MAX_TOKENS", 1, 100_000),
    mockModel,
    model: env.HARNESS_MODEL ?? "claude-sonnet-5-5",
    piAgentDir: resolve(dataDir, "pi"),
    piSessionsDir: resolve(dataDir, "pi-sessions"),
    port,
    repoRoot: REPO_ROOT,
    sandboxCredentialNames: (env.HARNESS_SANDBOX_CREDENTIAL_NAMES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    searxngUrl: env.HARNESS_SEARXNG_URL,
    sessionsDir: resolve(dataDir, "sessions"),
    skillsGlobalDir: resolve(dataDir, "skills"),
    skillsSystemDir: resolve(REPO_ROOT, "skills"),
    subAgentMaxDagNodes: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_MAX_DAG_NODES ?? "12",
      "HARNESS_SUBAGENT_MAX_DAG_NODES",
      1,
      64,
    ),
    subAgentMaxDurationMs: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_MAX_DURATION_MS ?? "600000",
      "HARNESS_SUBAGENT_MAX_DURATION_MS",
      1,
      86_400_000,
    ),
    subAgentMaxTokens: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_MAX_TOKENS ?? "0",
      "HARNESS_SUBAGENT_MAX_TOKENS",
      0,
      100_000_000,
    ),
    subAgentMaxTotal: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_MAX_TOTAL ?? "12",
      "HARNESS_SUBAGENT_MAX_TOTAL",
      1,
      64,
    ),
    subAgentRunMaxDurationMs: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_RUN_MAX_DURATION_MS ?? "0",
      "HARNESS_SUBAGENT_RUN_MAX_DURATION_MS",
      0,
      86_400_000,
    ),
    subAgentRunMaxTokens: parseNonNegativeInteger(
      env.HARNESS_SUBAGENT_RUN_MAX_TOKENS ?? "0",
      "HARNESS_SUBAGENT_RUN_MAX_TOKENS",
      0,
      1_000_000_000,
    ),
    webDistPath: env.HARNESS_WEB_DIST
      ? resolvePath(env.HARNESS_WEB_DIST)
      : resolve(REPO_ROOT, "apps/web/dist"),
    webOrigin,
    workspaceRoot,
  };
}

function resolvePath(value: string): string {
  return resolve(REPO_ROOT, value);
}

function parseOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("HARNESS_WEB_ORIGIN 必须是 HTTP(S) 地址");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("HARNESS_WEB_ORIGIN 必须是回环地址");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("HARNESS_WEB_ORIGIN 只能是 origin，不能包含路径、查询或片段");
  }
  return url.origin;
}

function parseNonNegativeInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return parsed;
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return parsed;
}
