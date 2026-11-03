import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type { HarnessEvent, KnowledgeHit } from "@harness/core";
import { HarnessEventType } from "@harness/core/events";
import type { LiteratureReport } from "@harness/core/literature";
import { normalizeSandboxSettings } from "@harness/sandbox";
import { listWorkspaceEntries } from "@harness/tools";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import type { HarnessConfig } from "./config";
import { exportLiterature, type LiteratureExportFormat } from "./literature/export";
import type { MemoryService } from "./memory/memory-service";
import { MemoryServiceError } from "./memory/memory-service";
import { registerAttachmentRoutes } from "./routes/attachment-routes";
import { registerBackgroundCommandRoutes } from "./routes/background-command-routes";
import { registerBoardTaskRoutes } from "./routes/board-task-routes";
import { registerGitRoutes } from "./routes/git-routes";
import { registerMemoryRoutes } from "./routes/memory-routes";
import { registerProviderOAuthRoutes } from "./routes/provider-oauth-routes";
import { registerWorkflowRoutes } from "./routes/workflow-routes";
import { registerWorkspaceRegistryRoutes } from "./routes/workspace-registry-routes";
import { registerWorkspaceRoutes } from "./routes/workspace-routes";
import { type AttachmentService, AttachmentServiceError } from "./services/attachment-service";
import {
  type BackgroundCommandService,
  BackgroundCommandServiceError,
} from "./services/background-command-service";
import { type BoardTaskService, BoardTaskServiceError } from "./services/board-task-service";
import type { SessionEventBus } from "./services/event-bus";
import { FileChangeService, FileChangeServiceError } from "./services/file-change-service";
import { type GitService, GitServiceError } from "./services/git-service";
import { type LiteratureService, LiteratureServiceError } from "./services/literature-service";
import { ProviderOAuthError, type ProviderOAuthService } from "./services/provider-oauth-service";
import {
  ModelSettingsError,
  type ProviderSettingsService,
} from "./services/provider-settings-service";
import type { SessionSearchService } from "./services/session-search-service";
import { SessionServiceError } from "./services/session-service";
import type { SessionController } from "./services/session-types";
import type { TraceService } from "./services/trace-service";
import type { UsageService } from "./services/usage-service";
import { type WorkflowService, WorkflowServiceError } from "./services/workflow-service";
import {
  WorkspaceRegistryError,
  type WorkspaceRegistryService,
} from "./services/workspace-registry-service";
import { type WorkspaceService, WorkspaceServiceError } from "./services/workspace-service";
import { installSkillFromGithub } from "./skills/skill-installer";
import { SkillError, SkillRegistry, type SkillScope } from "./skills/skill-registry";
import type { LiteratureRecord } from "./storage/database";

export interface ServerDependencies {
  attachments: AttachmentService;
  backgroundCommands: BackgroundCommandService;
  git: GitService;
  board: BoardTaskService;
  bus: SessionEventBus;
  config: HarnessConfig;
  knowledge: (
    query: string,
    limit: number,
    kinds?: readonly ("literature" | "memory" | "workspace")[],
  ) => readonly KnowledgeHit[] | Promise<readonly KnowledgeHit[]>;
  literature: LiteratureService;
  memory: MemoryService;
  providerOAuth?: ProviderOAuthService | undefined;
  providerSettings?: ProviderSettingsService | undefined;
  sessionSearch: SessionSearchService;
  sessions: SessionController;
  trace: TraceService;
  usage: UsageService;
  workflows: WorkflowService;
  workspace: WorkspaceService;
  workspaceRegistry: WorkspaceRegistryService;
}

const createSessionSchema = z.object({
  modelId: z.string().min(1).max(200).optional(),
  providerId: z.string().min(1).max(64).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  title: z.string().max(120).optional(),
  workspaceId: z.string().min(1).max(64).optional(),
  workspaceRoot: z.string().min(1).max(4_096).optional(),
});
const sessionModelSchema = z.object({
  modelId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(64),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});

const imageSchema = z.object({
  data: z.string().min(1).max(1_500_000),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
const messageSchema = z.object({
  attachments: z.array(z.string().min(1).max(100)).max(5).optional(),
  images: z.array(imageSchema).max(4).optional(),
  planMode: z.boolean().optional(),
  text: z.string().max(100_000),
});
const rewriteSchema = z.object({
  fromTimestamp: z.number().int().positive(),
  images: z.array(imageSchema).max(4).optional(),
  planMode: z.boolean().optional(),
  text: z.string().max(100_000),
});
const fileChangeActionSchema = z.object({
  paths: z.array(z.string().min(1).max(1_024)).min(1).max(50),
});
const sandboxSettingsSchema = z.object({
  allowedDomains: z.array(z.string().max(253)).max(100).optional(),
  deniedDomains: z.array(z.string().max(253)).max(100).optional(),
  profile: z.enum(["off", "read_only", "workspace_write"]),
});
const skillToggleSchema = z.object({ enabled: z.boolean() });
const skillScopeSchema = z.enum(["global", "project", "system"]);
const skillInstallSchema = z.object({
  ref: z.string().min(1).max(120).optional(),
  repo: z.string().min(3).max(200),
  subdir: z.string().min(1).max(300).optional(),
});
const usageQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  modelId: z.string().min(1).max(200).optional(),
  providerId: z.string().min(1).max(64).optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});
const abortSchema = z.object({ runId: z.string().min(1) });
const workflowSchema = z.object({
  nodes: z
    .array(
      z.object({
        agentType: z.enum(["explorer", "reviewer", "worker"]).optional(),
        dependsOn: z.array(z.string().min(1).max(64)).max(8).optional(),
        id: z.string().min(1).max(64),
        task: z.string().min(1).max(20_000),
        title: z.string().min(1).max(120).optional(),
      }),
    )
    .min(1)
    .max(12),
});
const userInputAnswerSchema = z.object({
  questionId: z.string().min(1).max(64),
  selectedOption: z.string().min(1).max(64).optional(),
  selectedOptions: z.array(z.string().min(1).max(64)).max(12).optional(),
  value: z.string().min(1).max(4_096),
});
const userInputSchema = z.object({ answers: z.array(userInputAnswerSchema).min(1).max(8) });
const checkpointCompareSchema = z.object({
  base: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
});
const approvalSchema = z.object({
  allowPrefix: z.string().min(1).max(120).optional(),
  decision: z.enum(["approved", "denied"]),
  grantSession: z.boolean().optional(),
});
const renameSchema = z.object({ title: z.string().min(1).max(120) });
const settingsSchema = z.object({
  approvalMode: z.enum(["auto_approve", "full_access", "request_approval"]),
});
const commandPrefixSchema = z.object({ prefix: z.string().min(1).max(120) });
const modelSettingsSchema = z.object({
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  mock: z.boolean().optional(),
  modelId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(64),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});
const modelTestSchema = z.object({
  apiKey: z.string().max(500).optional(),
  modelId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(64),
});
const customProviderSchema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().min(1).max(2_048),
  models: z
    .array(
      z.object({
        contextWindow: z.number().int().positive(),
        id: z.string().min(1).max(200),
        maxTokens: z.number().int().positive(),
        name: z.string().min(1).max(200),
        reasoning: z.boolean(),
      }),
    )
    .min(1)
    .max(100),
  name: z.string().min(1).max(120),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  requiresApiKey: z.boolean(),
});
const literatureExportSchema = z.enum(["bibtex", "json", "markdown"]);

export async function createServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const {
    attachments,
    backgroundCommands,
    board,
    git,
    bus,
    config,
    knowledge,
    literature,
    memory,
    providerOAuth,
    providerSettings,
    sessionSearch,
    sessions,
    trace,
    usage,
    workflows,
    workspace,
    workspaceRegistry,
  } = dependencies;
  const server = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: { level: process.env.HARNESS_LOG_LEVEL ?? "info" },
  });

  const allowedHosts = buildAllowedHosts(config);
  const allowedOrigins = buildAllowedOrigins(config);
  const fileChanges = new FileChangeService({ protectedPaths: [config.dataDir] });
  const skillRegistryFor = (workspaceRoot?: string): SkillRegistry =>
    new SkillRegistry({
      disabled: sessions.getDisabledSkills(),
      globalDir: config.skillsGlobalDir,
      systemDir: config.skillsSystemDir,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });

  await server.register(cors, {
    credentials: false,
    origin(origin, callback) {
      // 不在 CORS 层抛错；统一交给 onRequest 返回 403，避免变成 500。
      if (origin === undefined || allowedOrigins.has(origin)) callback(null, true);
      else callback(null, false);
    },
  });
  await server.register(multipart, {
    limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  });

  server.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (host === undefined || !allowedHosts.has(host)) {
      return reply.status(403).send({ code: "INVALID_HOST", message: "请求 Host 不被允许" });
    }
    const isWorkflowWebhook =
      request.method === "POST" && /^\/api\/workflows\/[^/]+\/webhook(?:\?|$)/u.test(request.url);
    // 不对 URL 做前缀鉴权；所有非简单请求统一要求 Origin + 自定义头，避免编码路径绕过。
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isWorkflowWebhook) {
      const origin = request.headers.origin;
      if (
        origin === undefined ||
        !allowedOrigins.has(origin) ||
        request.headers["x-harness-request"] !== "1"
      ) {
        return reply
          .status(403)
          .send({ code: "INVALID_REQUEST_ORIGIN", message: "请求来源不被允许" });
      }
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "INVALID_INPUT",
        message: error.issues.map((issue) => issue.message).join("; ") || "请求参数无效",
      });
    }
    if (error instanceof SessionServiceError) {
      return reply.status(statusForSessionError(error.code)).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof BoardTaskServiceError) {
      return reply.status(statusForBoardTaskError(error.code)).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof AttachmentServiceError) {
      return reply
        .status(error.code === "NOT_FOUND" ? 404 : error.code === "UNSUPPORTED" ? 415 : 400)
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof GitServiceError) {
      return reply.status(error.code === "NOT_REPO" ? 409 : 400).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof BackgroundCommandServiceError) {
      return reply.status(error.code === "NOT_FOUND" ? 404 : 400).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof WorkspaceServiceError) {
      return reply
        .status(error.code === "NOT_FOUND" ? 404 : error.code === "TOO_LARGE" ? 413 : 400)
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof SkillError) {
      return reply
        .status(
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT"
              ? 409
              : error.code === "TOO_LARGE"
                ? 413
                : 400,
        )
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof FileChangeServiceError) {
      return reply
        .status(
          error.code === "CONFLICT"
            ? 409
            : error.code === "NOT_FOUND"
              ? 404
              : error.code === "TOO_LARGE"
                ? 413
                : 400,
        )
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof WorkspaceRegistryError) {
      return reply
        .status(error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400)
        .send({ code: error.code, message: error.message });
    }
    if (error instanceof WorkflowServiceError) {
      return reply.status(error.code === "NOT_FOUND" ? 404 : 400).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof MemoryServiceError) {
      return reply.status(error.code === "NOT_FOUND" ? 404 : 400).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof LiteratureServiceError) {
      return reply.status(statusForLiteratureError(error.code)).send({
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof ModelSettingsError) {
      return reply.status(400).send({ code: "INVALID_MODEL_SETTINGS", message: error.message });
    }
    if (error instanceof ProviderOAuthError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "NOT_SUPPORTED"
            ? 501
            : error.code === "BUSY"
              ? 409
              : 400;
      return reply.status(status).send({ code: error.code, message: error.message });
    }
    if (isHttpError(error) && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        code: error.code ?? "INVALID_REQUEST",
        message: error.message,
      });
    }
    request.log.error({ err: error }, "请求处理失败");
    return reply.status(500).send({ code: "INTERNAL", message: "服务内部错误" });
  });

  server.get("/api/usage", async (request) => {
    const query = usageQuerySchema.parse(request.query);
    return usage.summarize(query);
  });

  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/trace",
    async (request) => {
      sessions.getSession(request.params.sessionId);
      return trace.trace(request.params.sessionId);
    },
  );

  server.get<{ Params: { sessionId: string; toolCallId: string } }>(
    "/api/sessions/:sessionId/tools/:toolCallId",
    async (request) => {
      sessions.getSession(request.params.sessionId);
      const events = await sessions.readEvents(request.params.sessionId, 0);
      let input: unknown = null;
      let result: string | null = null;
      let error: string | null = null;
      let toolName = "";
      for (const event of events) {
        const data = asEventRecord(event.data);
        if (data.toolCallId !== request.params.toolCallId) continue;
        if (event.type === "tool.started") {
          input = data.input ?? null;
          toolName = typeof data.toolName === "string" ? data.toolName : "";
        } else if (event.type === "tool.completed") {
          result = typeof data.result === "string" ? data.result : null;
          toolName = typeof data.toolName === "string" ? data.toolName : toolName;
        } else if (event.type === "tool.failed") {
          error = typeof data.error === "string" ? data.error : null;
          toolName = typeof data.toolName === "string" ? data.toolName : toolName;
        }
      }
      return {
        error,
        input,
        result: result === null ? null : result.slice(0, 1_000_000),
        toolCallId: request.params.toolCallId,
        toolName,
      };
    },
  );

  server.get("/api/health", async () => {
    const modelSettings = providerSettings?.get();
    return {
      model: modelSettings?.modelId ?? config.model,
      ok: true,
      version: "0.1.0",
    };
  });

  const settingsView = () => {
    const modelSettings = providerSettings?.get();
    return {
      ...sessions.getSettings(),
      apiKeyConfigured: modelSettings?.apiKeyConfigured ?? false,
      model: modelSettings?.modelId ?? config.model,
      models: modelSettings?.models ?? [],
      providerId: modelSettings?.providerId ?? "anthropic",
      providerName: modelSettings?.providerName ?? "Anthropic",
      providers: modelSettings?.providers ?? [],
      thinkingLevel: modelSettings?.thinkingLevel ?? "medium",
    };
  };

  server.get("/api/settings", async () => settingsView());

  server.put("/api/settings", async (request) => {
    const body = settingsSchema.parse(request.body);
    sessions.setApprovalMode(body.approvalMode);
    return settingsView();
  });

  server.put("/api/settings/sandbox", async (request) => {
    const body = sandboxSettingsSchema.parse(request.body);
    sessions.setSandboxSettings(
      normalizeSandboxSettings({
        allowedDomains: body.allowedDomains ?? [],
        deniedDomains: body.deniedDomains ?? [],
        profile: body.profile,
      }),
    );
    return settingsView();
  });

  server.put<{ Params: { id: string; scope: string } }>(
    "/api/settings/skills/:scope/:id",
    async (request) => {
      const scope = skillScopeSchema.parse(request.params.scope);
      const body = skillToggleSchema.parse(request.body);
      const disabled = sessions.setSkillEnabled(scope, request.params.id, body.enabled);
      return { disabled };
    },
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/skills",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      return { skills: await skillRegistryFor(session.workspaceRoot).list() };
    },
  );

  server.post("/api/skills/install", async (request) => {
    const body = skillInstallSchema.parse(request.body);
    return installSkillFromGithub(body, config.skillsGlobalDir);
  });

  server.get<{ Querystring: { workspaceId?: string } }>("/api/skills", async (request) => {
    let workspaceRoot: string | undefined;
    if (request.query.workspaceId !== undefined && request.query.workspaceId !== "") {
      const workspaces = await workspaceRegistry.list();
      const workspace = workspaces.find((item) => item.id === request.query.workspaceId);
      if (workspace === undefined) {
        throw new WorkspaceRegistryError("NOT_FOUND", "工作区不存在");
      }
      workspaceRoot = workspace.rootPath;
    }
    return { skills: await skillRegistryFor(workspaceRoot).list({ includeDisabled: true }) };
  });

  server.get<{ Params: { id: string; scope: string }; Querystring: { workspaceId?: string } }>(
    "/api/skills/:scope/:id",
    async (request) => {
      const scope = skillScopeSchema.parse(request.params.scope) as SkillScope;
      let workspaceRoot: string | undefined;
      if (request.query.workspaceId !== undefined && request.query.workspaceId !== "") {
        const workspaces = await workspaceRegistry.list();
        workspaceRoot = workspaces.find((item) => item.id === request.query.workspaceId)?.rootPath;
      }
      return skillRegistryFor(workspaceRoot).detail(scope, request.params.id);
    },
  );

  server.get("/api/settings/command-prefixes", async () => sessions.listAllowedCommandPrefixes());

  server.delete("/api/settings/command-prefixes", async (request) => {
    const body = commandPrefixSchema.parse(request.body);
    return sessions.removeAllowedCommandPrefix(body.prefix);
  });

  server.put("/api/settings/model", async (request) => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    const body = modelSettingsSchema.parse(request.body);
    await providerSettings.save({ ...body, mock: body.mock ?? false });
    return settingsView();
  });

  server.get<{ Querystring: { providerId?: string } }>("/api/settings/models", async (request) => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    const providerId = request.query.providerId?.trim();
    if (providerId === undefined || providerId === "") {
      throw new ModelSettingsError("缺少 providerId");
    }
    return { models: providerSettings.modelsFor(providerId) };
  });

  server.get("/api/models", async () => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    return providerSettings.catalog();
  });

  server.post("/api/models/test", async (request) => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    const body = modelTestSchema.parse(request.body);
    return providerSettings.testConnection(body);
  });

  server.get("/api/providers/custom", async () => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    return providerSettings.listCustomProviders();
  });

  server.post("/api/providers/custom", async (request, reply) => {
    if (providerSettings === undefined) {
      throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
    }
    const body = customProviderSchema.parse(request.body);
    return reply.status(201).send(await providerSettings.saveCustomProvider(body));
  });

  server.delete<{ Params: { providerId: string } }>(
    "/api/providers/custom/:providerId",
    async (request, reply) => {
      if (providerSettings === undefined) {
        throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
      }
      providerSettings.removeCustomProvider(request.params.providerId);
      return reply.status(204).send();
    },
  );

  server.get<{ Querystring: { includeArchived?: string } }>("/api/sessions", async (request) =>
    sessions
      .listSessions(request.query.includeArchived === "1")
      .map((session) => ({ ...session, isRunning: sessions.isSessionRunning(session.id) })),
  );

  server.get<{ Querystring: { limit?: string; q?: string } }>(
    "/api/sessions/search",
    async (request, reply) => {
      const query = request.query.q?.trim() ?? "";
      if (query === "" || query.length > 200) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "q 必须为 1-200 个字符" });
      }
      const parsedLimit = request.query.limit === undefined ? 20 : Number(request.query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "limit 必须为 1-50" });
      }
      return searchSessions(sessions, sessionSearch, query, parsedLimit);
    },
  );

  server.post("/api/sessions", async (request, reply) => {
    const body = createSessionSchema.parse(request.body ?? {});
    const { modelId, providerId, thinkingLevel, workspaceId, ...sessionInput } = body;
    const workspaceRoot =
      workspaceId === undefined ? body.workspaceRoot : workspaceRegistry.requireRoot(workspaceId);
    let selection: { modelId: string; providerId: string; thinkingLevel: string } | undefined;
    if (providerSettings !== undefined) {
      const defaults = providerSettings.get();
      const selected = {
        modelId: modelId ?? defaults.modelId,
        providerId: providerId ?? defaults.providerId,
        thinkingLevel: thinkingLevel ?? defaults.thinkingLevel,
      };
      await providerSettings.validateSelection(
        selected.providerId,
        selected.modelId,
        selected.thinkingLevel,
      );
      selection = selected;
    }
    const session = await sessions.createSession({
      ...sessionInput,
      ...(selection ?? {}),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    return reply.status(201).send(session);
  });

  server.patch<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/model",
    async (request) => {
      if (providerSettings === undefined) {
        throw new ModelSettingsError("当前执行引擎不支持运行时模型配置");
      }
      const body = sessionModelSchema.parse(request.body);
      await providerSettings.validateSelection(body.providerId, body.modelId, body.thinkingLevel);
      return sessions.updateSessionModel(
        request.params.sessionId,
        body.providerId,
        body.modelId,
        body.thinkingLevel,
      );
    },
  );

  server.get<{ Querystring: { base?: string; target?: string } }>(
    "/api/sessions/compare",
    async (request, reply) => {
      const base = request.query.base?.trim() ?? "";
      const target = request.query.target?.trim() ?? "";
      if (base === "" || target === "" || base === target) {
        return reply
          .status(400)
          .send({ code: "INVALID_INPUT", message: "base/target 必须不同且非空" });
      }
      return sessions.compareSessions(base, target);
    },
  );

  server.get<{ Querystring: { source?: string; target?: string } }>(
    "/api/sessions/merge-preview",
    async (request, reply) => {
      const source = request.query.source?.trim() ?? "";
      const target = request.query.target?.trim() ?? "";
      if (source === "" || target === "" || source === target) {
        return reply
          .status(400)
          .send({ code: "INVALID_INPUT", message: "source/target 必须不同且非空" });
      }
      return sessions.previewCodeMerge(target, source);
    },
  );

  server.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request) =>
    sessions.getSnapshot(request.params.sessionId),
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/merge-code",
    async (request, reply) => {
      const body = z.object({ sourceSessionId: z.string().min(1) }).parse(request.body);
      const result = await sessions.mergeCode(request.params.sessionId, body.sourceSessionId);
      await sessionSearch.reindexSession(result.session.id);
      return reply.status(201).send(result);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/merge",
    async (request, reply) => {
      const body = z.object({ sourceSessionId: z.string().min(1) }).parse(request.body);
      const session = await sessions.mergeSessions(request.params.sessionId, body.sourceSessionId);
      await sessionSearch.reindexSession(session.id);
      return reply.status(201).send(session);
    },
  );

  server.patch<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request) => {
    const body = renameSchema.parse(request.body);
    sessions.renameSession(request.params.sessionId, body.title);
    return sessions.getSession(request.params.sessionId);
  });

  server.post<{
    Params: { sessionId: string };
    Querystring: { fromTimestamp?: string };
  }>("/api/sessions/:sessionId/fork", async (request, reply) => {
    const fromTimestamp =
      request.query.fromTimestamp === undefined ? undefined : Number(request.query.fromTimestamp);
    if (fromTimestamp !== undefined && (!Number.isInteger(fromTimestamp) || fromTimestamp <= 0)) {
      return reply
        .status(400)
        .send({ code: "INVALID_INPUT", message: "fromTimestamp 必须是正整数" });
    }
    const session = await sessions.forkSession(request.params.sessionId, fromTimestamp);
    await sessionSearch.reindexSession(session.id);
    return reply.status(201).send(session);
  });

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/rewrite",
    async (request, reply) => {
      const body = rewriteSchema.parse(request.body);
      const result = await sessions.rewriteSession(
        request.params.sessionId,
        body.fromTimestamp,
        body.text,
        body.images,
        body.planMode ?? false,
      );
      await sessionSearch.reindexSession(result.session.id);
      return reply.status(201).send(result);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/resume",
    async (request) => sessions.resumeSession(request.params.sessionId),
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/restore",
    async (request) => {
      sessions.restoreSession(request.params.sessionId);
      return sessions.getSession(request.params.sessionId);
    },
  );

  server.post<{ Params: { action: string; sessionId: string } }>(
    "/api/sessions/:sessionId/file-changes/:action",
    async (request) => {
      const action = request.params.action;
      if (action !== "undo" && action !== "replay") {
        throw new FileChangeServiceError("INVALID", "action 必须是 undo 或 replay");
      }
      const body = fileChangeActionSchema.parse(request.body);
      const session = sessions.getSession(request.params.sessionId);
      const events = await sessions.readEvents(request.params.sessionId, 0);
      const paths = await fileChanges.apply(session.workspaceRoot, events, body.paths, action);
      return { action, paths };
    },
  );

  server.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request, reply) => {
      sessions.archiveSession(request.params.sessionId);
      return reply.status(204).send();
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    async (request, reply) => {
      const body = messageSchema.parse(request.body);
      const result = await sessions.startRun(
        request.params.sessionId,
        body.text,
        body.images,
        body.planMode,
        body.attachments,
      );
      return reply.status(202).send(result);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/steer",
    async (request, reply) => {
      const body = messageSchema.parse(request.body);
      const disposition = await sessions.steerRun(request.params.sessionId, body.text, body.images);
      return reply.status(202).send({ disposition });
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/workflows",
    async (request, reply) => {
      const body = workflowSchema.parse(request.body);
      const result = await sessions.startWorkflow(request.params.sessionId, body.nodes);
      return reply.status(202).send(result);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/abort",
    async (request, reply) => {
      const body = abortSchema.parse(request.body);
      await sessions.abort(request.params.sessionId, body.runId);
      return reply.status(202).send({ ok: true });
    },
  );

  server.post<{ Params: { approvalId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/approvals/:approvalId",
    async (request) => {
      const body = approvalSchema.parse(request.body);
      sessions.resolveApproval(
        request.params.sessionId,
        request.params.approvalId,
        body.decision === "approved",
        {
          ...(body.allowPrefix === undefined ? {} : { allowPrefix: body.allowPrefix }),
          ...(body.grantSession === undefined ? {} : { grantSession: body.grantSession }),
        },
      );
      return { ok: true };
    },
  );

  server.post<{ Params: { inputId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/inputs/:inputId",
    async (request) => {
      const body = userInputSchema.parse(request.body);
      await sessions.resolveUserInput(
        request.params.sessionId,
        request.params.inputId,
        body.answers.map((answer) => ({
          questionId: answer.questionId,
          ...(answer.selectedOption === undefined ? {} : { selectedOption: answer.selectedOption }),
          ...(answer.selectedOptions === undefined
            ? {}
            : { selectedOptions: answer.selectedOptions }),
          value: answer.value,
        })),
      );
      return { ok: true };
    },
  );

  server.get<{
    Params: { sessionId: string };
    Querystring: { depth?: string; path?: string };
  }>("/api/sessions/:sessionId/files", async (request, reply) => {
    const session = sessions.getSession(request.params.sessionId);
    const depth = request.query.depth === undefined ? 3 : Number(request.query.depth);
    if (!Number.isInteger(depth) || depth < 1 || depth > 8) {
      return reply.status(400).send({ code: "INVALID_INPUT", message: "depth 必须为 1-8" });
    }
    const path = request.query.path?.trim() ?? ".";
    try {
      return await listWorkspaceEntries({
        depth,
        path,
        protectedPaths: [config.dataDir],
        workspaceRoot: session.workspaceRoot,
      });
    } catch (error: unknown) {
      return reply.status(400).send({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : "无法读取工作区",
      });
    }
  });

  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/queued",
    async (request) => sessions.listQueued(request.params.sessionId),
  );

  server.delete<{ Params: { inputId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/queued/:inputId",
    async (request, reply) => {
      const removed = await sessions.removeQueued(request.params.sessionId, request.params.inputId);
      return removed ? reply.status(204).send() : reply.status(404).send({ code: "NOT_FOUND" });
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/compact",
    async (request, reply) => {
      await sessions.compact(request.params.sessionId);
      return reply.status(202).send({ ok: true });
    },
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/checkpoints",
    async (request) => ({
      checkpoints: await sessions.listCheckpoints(request.params.sessionId),
    }),
  );

  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/checkpoints/compare",
    async (request) => {
      const query = checkpointCompareSchema.parse(request.query);
      return sessions.compareCheckpoints(request.params.sessionId, query.base, query.target);
    },
  );

  server.post<{ Params: { checkpointId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/checkpoints/:checkpointId/restore",
    async (request) => {
      const checkpoint = await sessions.restoreCheckpoint(
        request.params.sessionId,
        request.params.checkpointId,
      );
      return { checkpoint, checkpointId: request.params.checkpointId };
    },
  );

  server.get<{ Params: { sessionId: string }; Querystring: { afterSeq?: string } }>(
    "/api/sessions/:sessionId/events",
    async (request, reply) => {
      const sessionId = request.params.sessionId;
      sessions.getSession(sessionId);
      const afterSeq = parseAfterSeq(request.query.afterSeq);
      return streamSessionEvents({ bus, request, reply, sessionId, sessions, afterSeq });
    },
  );

  // Literature
  server.get<{ Querystring: { kind?: string; limit?: string; q?: string } }>(
    "/api/knowledge/search",
    async (request, reply) => {
      const query = request.query.q?.trim() ?? "";
      if (query === "" || query.length > 500) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "q 必须为 1-500 个字符" });
      }
      const parsedLimit = request.query.limit === undefined ? 10 : Number(request.query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "limit 必须为 1-50" });
      }
      const kinds =
        request.query.kind === "all" ? undefined : (["literature", "workspace"] as const);
      return knowledge(query, parsedLimit, kinds);
    },
  );

  server.get("/api/literature", async () => literature.list().map(toLiteratureSummary));

  server.post("/api/literature/upload", async (request) => {
    const file = await request.file();
    if (file === undefined) {
      throw new LiteratureServiceError("INVALID", "缺少上传文件");
    }
    const buffer = await file.toBuffer();
    const record = await literature.upload({ buffer, fileName: file.filename });
    return toLiteratureDetail(record);
  });

  server.get<{ Params: { id: string } }>("/api/literature/:id", async (request) =>
    toLiteratureDetail(literature.get(request.params.id)),
  );

  server.get<{ Params: { id: string } }>("/api/literature/:id/text", async (request) =>
    literature.getText(request.params.id),
  );

  server.post<{ Params: { id: string } }>("/api/literature/:id/cancel", async (request) =>
    toLiteratureDetail(literature.cancel(request.params.id)),
  );

  server.post<{ Params: { id: string } }>("/api/literature/:id/analyze", async (request, reply) => {
    const record = literature.analyze(request.params.id);
    return reply.status(202).send(toLiteratureDetail(record));
  });

  server.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/literature/:id/export",
    async (request, reply) => {
      const record = literature.get(request.params.id);
      if (record.reportJson === null) {
        throw new LiteratureServiceError("INVALID", "尚未生成解析结果，无法导出");
      }
      const format: LiteratureExportFormat = literatureExportSchema.parse(
        request.query.format ?? "markdown",
      );
      const artifact = exportLiterature(format, JSON.parse(record.reportJson) as LiteratureReport);
      const fileName = `${sanitizeDownloadName(record.title || record.fileName)}.${artifact.extension}`;
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename="literature.${artifact.extension}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .type(artifact.contentType)
        .send(artifact.content);
    },
  );

  server.delete<{ Params: { id: string } }>("/api/literature/:id", async (request, reply) => {
    await literature.delete(request.params.id);
    return reply.status(204).send();
  });

  await server.register(async (instance) => {
    await registerBoardTaskRoutes(instance, board);
    await registerMemoryRoutes(instance, memory);
    await registerWorkflowRoutes(instance, workflows);
    await registerAttachmentRoutes(instance, attachments, sessions);
    await registerWorkspaceRoutes(instance, workspace, sessions);
    await registerWorkspaceRegistryRoutes(instance, workspaceRegistry);
    if (providerOAuth !== undefined) {
      await registerProviderOAuthRoutes(instance, providerOAuth);
    }
    await registerBackgroundCommandRoutes(instance, backgroundCommands, sessions);
    await registerGitRoutes(instance, git, sessions);
  });

  if (existsSync(config.webDistPath)) {
    await server.register(fastifyStatic, { root: config.webDistPath });
    server.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.status(404).send({ code: "NOT_FOUND", message: "Route not found" });
    });
  }

  return server;
}

function buildAllowedHosts(config: HarnessConfig): Set<string> {
  const hosts = new Set<string>([
    `${config.host}:${config.port}`,
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
  ]);
  const origin = new URL(config.webOrigin);
  hosts.add(origin.host);
  const twin = origin.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  hosts.add(`${twin}:${origin.port || (origin.protocol === "https:" ? "443" : "80")}`);
  return hosts;
}

function buildAllowedOrigins(config: HarnessConfig): Set<string> {
  const origin = new URL(config.webOrigin);
  const origins = new Set<string>([config.webOrigin]);
  const twinHost = origin.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  origins.add(
    `${origin.protocol}//${twinHost}:${origin.port || (origin.protocol === "https:" ? "443" : "80")}`,
  );
  // 生产模式由 daemon 自己托管 Web 时，浏览器 Origin 是 daemon 的地址。
  origins.add(`http://127.0.0.1:${config.port}`);
  origins.add(`http://localhost:${config.port}`);
  return origins;
}

interface StreamInput {
  afterSeq: number;
  bus: SessionEventBus;
  request: FastifyRequest;
  reply: FastifyReply;
  sessionId: string;
  sessions: SessionController;
}

async function streamSessionEvents(input: StreamInput): Promise<void> {
  const { afterSeq, bus, request, reply, sessionId, sessions } = input;
  const pendingLive: HarnessEvent[] = [];
  let isClosed = false;
  let isReplaying = true;
  let lastSentSeq = afterSeq;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: () => void = () => undefined;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    unsubscribe();
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (!reply.raw.destroyed) reply.raw.end();
  };
  const send = (event: HarnessEvent) => {
    if (isClosed || event.seq <= lastSentSeq || reply.raw.destroyed) return;
    try {
      reply.raw.write(`id: ${event.id}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      lastSentSeq = event.seq;
    } catch {
      cleanup();
    }
  };

  // 先注册断连监听，再等待任何异步读取，避免快照期间断开导致订阅泄漏。
  request.raw.once("close", cleanup);
  reply.raw.once("close", cleanup);

  reply.hijack();
  reply.raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write("retry: 2000\n\n");

  const unsubscribeFromBus = bus.subscribe(sessionId, (event) => {
    if (isReplaying) pendingLive.push(event);
    else send(event);
  });
  unsubscribe = unsubscribeFromBus;

  try {
    const events = await sessions.readEvents(sessionId, afterSeq);
    for (const event of events) send(event);
    for (const event of bus.replayAfter(sessionId, lastSentSeq)) send(event);
    isReplaying = false;
    pendingLive.sort((left, right) => left.seq - right.seq);
    for (const event of pendingLive) send(event);
    pendingLive.length = 0;

    heartbeat = setInterval(() => {
      if (isClosed || reply.raw.destroyed) return;
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, 15_000);
    heartbeat.unref();

    await new Promise<void>((resolve) => {
      if (isClosed) resolve();
      else request.raw.once("close", resolve);
    });
  } catch {
    if (!reply.raw.destroyed) reply.raw.destroy();
  } finally {
    cleanup();
  }
}

function parseAfterSeq(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SessionServiceError("INVALID", "afterSeq 必须是非负整数");
  }
  return parsed;
}

function toLiteratureSummary(record: LiteratureRecord) {
  const { reportJson, ...rest } = record;
  return { ...rest, hasReport: reportJson !== null };
}

function toLiteratureDetail(record: LiteratureRecord) {
  const { reportJson, ...rest } = record;
  return {
    ...rest,
    report: reportJson === null ? null : (JSON.parse(reportJson) as unknown),
  };
}

async function searchSessions(
  sessions: SessionController,
  sessionSearch: SessionSearchService,
  query: string,
  limit: number,
): Promise<
  {
    archivedAt: number | null;
    matchedTitle: boolean;
    role: string | null;
    seq: number | null;
    sessionId: string;
    snippet: string;
    title: string;
    updatedAt: number;
    workspaceRoot: string;
  }[]
> {
  const needle = query.toLocaleLowerCase();
  const hits: {
    archivedAt: number | null;
    matchedTitle: boolean;
    role: string | null;
    seq: number | null;
    sessionId: string;
    snippet: string;
    title: string;
    updatedAt: number;
    workspaceRoot: string;
  }[] = [];
  for (const session of sessions.listSessions()) {
    if (session.title.toLocaleLowerCase().includes(needle)) {
      hits.push({
        archivedAt: session.archivedAt,
        matchedTitle: true,
        role: null,
        seq: null,
        sessionId: session.id,
        snippet: session.title,
        title: session.title,
        updatedAt: session.updatedAt,
        workspaceRoot: session.workspaceRoot,
      });
    }
  }
  try {
    for (const hit of sessionSearch.search(query, limit * 3)) {
      const session = sessions.getSession(hit.sessionId);
      const index = hit.content.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({
        archivedAt: session.archivedAt,
        matchedTitle: false,
        role: hit.role,
        seq: hit.seq,
        sessionId: hit.sessionId,
        snippet: snippetAround(hit.content, index, query.length),
        title: session.title,
        updatedAt: session.updatedAt,
        workspaceRoot: session.workspaceRoot,
      });
    }
  } catch {
    return searchSessionsLinear(sessions, query, limit);
  }
  return hits.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, Math.max(1, limit));
}

async function searchSessionsLinear(
  sessions: SessionController,
  query: string,
  limit: number,
): Promise<
  {
    archivedAt: number | null;
    matchedTitle: boolean;
    role: string | null;
    seq: number | null;
    sessionId: string;
    snippet: string;
    title: string;
    updatedAt: number;
    workspaceRoot: string;
  }[]
> {
  const needle = query.toLocaleLowerCase();
  const hits: {
    archivedAt: number | null;
    matchedTitle: boolean;
    role: string | null;
    seq: number | null;
    sessionId: string;
    snippet: string;
    title: string;
    updatedAt: number;
    workspaceRoot: string;
  }[] = [];
  for (const session of sessions.listSessions()) {
    if (hits.length >= limit) break;
    if (session.title.toLocaleLowerCase().includes(needle)) {
      hits.push({
        archivedAt: session.archivedAt,
        matchedTitle: true,
        role: null,
        seq: null,
        sessionId: session.id,
        snippet: session.title,
        title: session.title,
        updatedAt: session.updatedAt,
        workspaceRoot: session.workspaceRoot,
      });
    }
    const events = await sessions.readEvents(session.id, 0);
    for (const event of [...events].reverse()) {
      if (hits.length >= limit) break;
      if (event.type !== HarnessEventType.MESSAGE_COMPLETED) continue;
      const text = messageTextOf(event.data);
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({
        archivedAt: session.archivedAt,
        matchedTitle: false,
        role: messageRoleOf(event.data),
        seq: event.seq,
        sessionId: session.id,
        snippet: snippetAround(text, index, query.length),
        title: session.title,
        updatedAt: session.updatedAt,
        workspaceRoot: session.workspaceRoot,
      });
    }
  }
  return hits;
}

function messageRoleOf(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.message)) return null;
  return typeof data.message.role === "string" ? data.message.role : null;
}

function messageTextOf(data: unknown): string {
  if (!isRecord(data) || !isRecord(data.message)) return "";
  const content = data.message.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n")
    .trim();
}

function snippetAround(text: string, index: number, length: number): string {
  const normalized = text.replace(/\s+/gu, " ");
  const from = Math.max(0, index - 50);
  const to = Math.min(normalized.length, index + length + 70);
  return `${from > 0 ? "…" : ""}${normalized.slice(from, to)}${to < normalized.length ? "…" : ""}`;
}

function asEventRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeDownloadName(value: string): string {
  const sanitized = [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? "-" : character,
    )
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return sanitized === "" ? "literature" : sanitized;
}

function isHttpError(
  error: unknown,
): error is Error & { code?: string | undefined; statusCode: number } {
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number";
}

function statusForBoardTaskError(code: BoardTaskServiceError["code"]): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "BUSY" || code === "CONFLICT" || code === "ARCHIVED") return 409;
  return 400;
}

function statusForSessionError(code: SessionServiceError["code"]): number {
  if (code === "NOT_FOUND" || code === "RUN_NOT_FOUND") return 404;
  if (code === "BUSY" || code === "ARCHIVED" || code === "CONFLICT") return 409;
  return 400;
}

function statusForLiteratureError(code: LiteratureServiceError["code"]): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "BUSY") return 409;
  if (code === "UNSUPPORTED") return 415;
  return 400;
}
