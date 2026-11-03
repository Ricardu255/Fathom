import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModelClient } from "@harness/providers";
import { loadConfig } from "./config";
import { HashEmbedder, HttpEmbedder } from "./memory/embedder";
import { MemoryService } from "./memory/memory-service";
import type { PiModelSetup } from "./pi/model";
import { createPiModelSetup } from "./pi/model";
import { createServer } from "./server";
import { AttachmentService } from "./services/attachment-service";
import { BackgroundCommandService } from "./services/background-command-service";
import { BoardTaskService } from "./services/board-task-service";
import { SessionEventBus } from "./services/event-bus";
import { GitService } from "./services/git-service";
import { LiteratureService } from "./services/literature-service";
import { PiSessionService } from "./services/pi-session-service";
import { ProviderCredentialStore } from "./services/provider-credential-store";
import { ProviderOAuthService } from "./services/provider-oauth-service";
import {
  migrateLegacyCredentials,
  ProviderSettingsService,
  readStoredModelSelection,
} from "./services/provider-settings-service";
import { SessionSearchService } from "./services/session-search-service";
import { SessionService } from "./services/session-service";
import type { SessionController } from "./services/session-types";
import { TraceService } from "./services/trace-service";
import { UsageService } from "./services/usage-service";
import { WorkflowFileWatcher } from "./services/workflow-file-watcher";
import { WorkflowScheduler } from "./services/workflow-scheduler";
import { WorkflowService } from "./services/workflow-service";
import { WorkspaceRegistryService } from "./services/workspace-registry-service";
import { WorkspaceService } from "./services/workspace-service";
import { HarnessDatabase } from "./storage/database";
import { SessionEventStore } from "./storage/event-store";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
await mkdir(config.workspaceRoot, { recursive: true });

const database = new HarnessDatabase(join(config.dataDir, "harness.sqlite"));
if (database.getWorkspaceByRoot(config.workspaceRoot) === null) {
  database.createWorkspace({ displayName: "默认工作区", rootPath: config.workspaceRoot });
}
const events = new SessionEventStore({
  directory: config.sessionsDir,
  onWarning: (message, details) => {
    console.warn(`[event-store] ${message}`, details ?? {});
  },
});
await events.initialize();

const bus = new SessionEventBus();
const attachments = new AttachmentService(database);
const backgroundCommands = new BackgroundCommandService({
  getApprovalMode: () => database.getSettings().approvalMode,
  getSandboxSettings: () => database.getSettings().sandbox,
});
const git = new GitService();
const workspaceService = new WorkspaceService({ protectedPaths: [config.dataDir] });
const workspaceRegistry = new WorkspaceRegistryService({
  database,
  protectedPaths: [config.dataDir],
});
const memory = new MemoryService({
  database,
  embedder:
    config.embeddingUrl === undefined
      ? new HashEmbedder()
      : new HttpEmbedder({
          ...(config.embeddingApiKey === undefined ? {} : { apiKey: config.embeddingApiKey }),
          dimensions: config.embeddingDimensions,
          model: config.embeddingModel,
          url: config.embeddingUrl,
        }),
});
await memory.initialize();
const modelClient = createModelClient({
  mock: config.mockModel,
  ...(config.anthropicApiKey === undefined ? {} : { apiKey: config.anthropicApiKey }),
});
const logger = {
  error: (details: Record<string, unknown>, message: string) => {
    console.error(`[harness] ${message}`, details);
  },
  warn: (details: Record<string, unknown>, message: string) => {
    console.warn(`[harness] ${message}`, details);
  },
};

let sessions: SessionController;
let piSetup: PiModelSetup | null = null;
let providerSettings: ProviderSettingsService | undefined;
let providerOAuth: ProviderOAuthService | undefined;
if (config.engine === "pi") {
  // 凭据先于模型选择加载：迁移必须发生在 readStoredModelSelection 之前，
  // 否则升级后的第一次启动会因为 SQLite 里已经删掉 Key 而静默回退 Mock。
  const credentials = new ProviderCredentialStore(join(config.dataDir, "credentials.json"), logger);
  await credentials.load();
  const migratedKeys = await migrateLegacyCredentials(database, credentials);
  if (migratedKeys > 0) {
    logger.warn({ count: migratedKeys }, "已把明文 API Key 从数据库迁移到凭据文件");
  }
  const storedModel = readStoredModelSelection(database, config, credentials);
  try {
    piSetup = await createPiModelSetup(config, {
      ...(storedModel.apiKey === undefined ? {} : { apiKey: storedModel.apiKey }),
      mock: storedModel.mock,
      model: storedModel.modelId,
      provider: storedModel.providerId,
    });
  } catch (error: unknown) {
    logger.warn({ err: error }, "持久化模型配置不可用，回退到本地测试模型以便打开设置页");
    piSetup = await createPiModelSetup(config, {
      mock: true,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
  }
  providerSettings = new ProviderSettingsService({
    config,
    credentials,
    database,
    modelSetup: piSetup,
  });
  await providerSettings.initializeCustomProviders();
  await providerSettings.restoreStoredSelection();
  await providerSettings.hydrateCredentials();
  providerOAuth = new ProviderOAuthService(
    piSetup.modelRuntime,
    () => providerSettings?.get().mock === true,
  );
  sessions = new PiSessionService({
    attachments,
    backgroundCommands,
    bus,
    config,
    database,
    events,
    logger,
    memory,
    modelSetup: piSetup,
    workspace: workspaceService,
  });
} else {
  sessions = new SessionService({
    backgroundCommands,
    bus,
    config,
    database,
    events,
    logger,
    memory,
    modelClient,
    workspace: workspaceService,
  });
}
await sessions.initialize();
const board = new BoardTaskService({ config, database, events, sessions });
const workflows = new WorkflowService({ database, sessions });
const workflowScheduler = new WorkflowScheduler({ logger, service: workflows });
const workflowFileWatcher = new WorkflowFileWatcher({
  logger,
  service: workflows,
  workspaceRoot: config.workspaceRoot,
});
workflowScheduler.start();
workflowFileWatcher.start();
const literature = new LiteratureService({ config, database, logger, modelClient });
await literature.initialize();
const usage = new UsageService({
  database,
  events,
  pricing: (providerId, modelId) => providerSettings?.pricingFor(providerId, modelId) ?? null,
});
const trace = new TraceService(events);
const sessionSearch = new SessionSearchService(database, events);
await sessionSearch.initialize();

const server = await createServer({
  attachments,
  backgroundCommands,
  board,
  git,
  bus,
  config,
  knowledge: (query, limit, kinds) => database.searchKnowledge(query, limit, kinds),
  literature,
  memory,
  providerOAuth,
  providerSettings,
  sessionSearch,
  sessions,
  trace,
  usage,
  workflows,
  workspace: workspaceService,
  workspaceRegistry,
});
await server.listen({ host: config.host, port: config.port });
server.log.info(
  {
    dataDir: config.dataDir,
    engine: config.engine,
    model: piSetup?.modelId ?? config.model,
    webOrigin: config.webOrigin,
    workspace: config.workspaceRoot,
  },
  "Agent Harness daemon started",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info({ signal }, "正在关闭");
  workflowScheduler.stop();
  workflowFileWatcher.stop();
  backgroundCommands.stopAll();
  try {
    await server.close();
  } finally {
    await sessions.close();
    bus.clear();
    database.close();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error("关闭失败", error);
      process.exitCode = 1;
    });
  });
}
