import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../config";
import type { PiModelSetup } from "../pi/model";
import type {
  CustomProviderModel,
  CustomProviderProtocol,
  CustomProviderRecord,
  HarnessDatabase,
} from "../storage/database";
import type { ProviderCredentialStore } from "./provider-credential-store";

const PROVIDER_KEY = "model_provider";
const MODEL_KEY = "model_id";
const THINKING_KEY = "model_thinking_level";
const MOCK_KEY = "model_mock";

/** 旧版把明文 Key 写在这个前缀下；现在只用来做一次性迁移。 */
const LEGACY_API_KEY_PREFIX = "model_api_key:";

export interface ProviderChoices {
  id: string;
  modelCount: number;
  name: string;
}

export interface ModelChoices {
  contextWindow: number;
  cost?: { input: number; output: number } | undefined;
  id: string;
  maxTokens: number;
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
}

export interface ProviderCatalog {
  configured: boolean;
  id: string;
  models: ModelChoices[];
  name: string;
  oauthSupported: boolean;
}

export interface ModelCatalogView {
  default: {
    modelId: string;
    providerId: string;
    thinkingLevel: string;
  };
  providers: ProviderCatalog[];
}

export interface CustomProviderView {
  baseUrl: string;
  configured: boolean;
  id: string;
  models: CustomProviderModel[];
  name: string;
  protocol: CustomProviderProtocol;
  requiresApiKey: boolean;
}

export interface SaveCustomProviderInput {
  apiKey?: string | undefined;
  baseUrl: string;
  models: readonly CustomProviderModel[];
  name: string;
  protocol: CustomProviderProtocol;
  requiresApiKey: boolean;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function storedThinkingLevel(database: HarnessDatabase): string {
  const value = database.getSetting(THINKING_KEY);
  return value !== null && THINKING_LEVELS.includes(value) ? value : "medium";
}

function normalizeCustomModels(input: readonly CustomProviderModel[]): CustomProviderModel[] {
  if (input.length === 0) throw new ModelSettingsError("至少需要配置一个模型");
  if (input.length > 100) throw new ModelSettingsError("模型数量不能超过 100 个");
  const seen = new Set<string>();
  return input.map((model) => {
    const id = model.id.trim();
    if (id === "" || id.length > 200 || seen.has(id)) {
      throw new ModelSettingsError("模型 ID 必须唯一且为 1-200 个字符");
    }
    seen.add(id);
    if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1024) {
      throw new ModelSettingsError(`${id}: 上下文窗口无效`);
    }
    if (
      !Number.isInteger(model.maxTokens) ||
      model.maxTokens < 1 ||
      model.maxTokens > model.contextWindow
    ) {
      throw new ModelSettingsError(`${id}: 最大输出无效`);
    }
    return {
      contextWindow: model.contextWindow,
      id,
      maxTokens: model.maxTokens,
      name: model.name.trim() || id,
      reasoning: model.reasoning === true,
    };
  });
}

export interface ModelSettingsView {
  apiKeyConfigured: boolean;
  apiKeySource: "environment" | "credentials" | null;
  mock: boolean;
  modelId: string;
  models: ModelChoices[];
  providerId: string;
  providerName: string;
  providers: ProviderChoices[];
  thinkingLevel: string;
}

export interface SaveModelSettingsInput {
  apiKey?: string | undefined;
  clearApiKey?: boolean | undefined;
  mock: boolean;
  modelId: string;
  providerId: string;
  thinkingLevel?: string | undefined;
}

export interface StoredModelSelection {
  apiKey: string | undefined;
  mock: boolean;
  modelId: string;
  providerId: string;
}

export class ModelSettingsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelSettingsError";
  }
}

/**
 * 把旧版存在 SQLite settings 里的明文 API Key 搬进凭据文件，并清掉旧行。
 *
 * 必须在读取模型选择之前执行：否则升级后的第一次启动会因为「settings 里没有 Key」而回退 Mock。
 * 无论是否迁移成功，SQLite 里的明文行都要删掉——留在那里就等于没做隔离。
 */
export async function migrateLegacyCredentials(
  database: HarnessDatabase,
  credentials: ProviderCredentialStore,
): Promise<number> {
  const legacy = database.listSettingsByPrefix(LEGACY_API_KEY_PREFIX);
  if (legacy.length === 0) return 0;
  const entries = new Map<string, string>();
  for (const { key, value } of legacy) {
    const providerId = key.slice(LEGACY_API_KEY_PREFIX.length);
    if (providerId !== "") entries.set(providerId, value);
  }
  const adopted = await credentials.adopt(entries);
  for (const { key } of legacy) database.deleteSetting(key);
  return adopted;
}

/** 启动时读取用户持久化的模型选择；没有 Key 时回退到 Mock，避免 daemon 无法启动。 */
export function readStoredModelSelection(
  database: HarnessDatabase,
  config: HarnessConfig,
  credentials: ProviderCredentialStore,
): StoredModelSelection {
  const providerId = database.getSetting(PROVIDER_KEY)?.trim() || "anthropic";
  const modelId = database.getSetting(MODEL_KEY)?.trim() || config.model;
  const apiKey =
    credentials.get(providerId) ??
    (providerId === "anthropic" ? config.anthropicApiKey : undefined);
  const storedMock = database.getSetting(MOCK_KEY);
  const mock =
    apiKey === undefined
      ? true
      : storedMock === "0"
        ? false
        : storedMock === "1"
          ? true
          : config.mockModel;
  return { apiKey, mock, modelId, providerId };
}

/**
 * 把设置页的模型选择热应用到共享的 PiModelSetup。
 * 已打开的 Session 继续使用旧模型；新建 Session/子 Agent 使用新模型。
 */
export class ProviderSettingsService {
  public constructor(
    private readonly options: {
      config: HarnessConfig;
      credentials: ProviderCredentialStore;
      database: HarnessDatabase;
      modelSetup: PiModelSetup;
    },
  ) {}

  public get(): ModelSettingsView {
    const { config, credentials, database, modelSetup } = this.options;
    const providerId = modelSetup.providerId;
    const provider = modelSetup.modelRuntime.getProvider(providerId);
    const storedKey = credentials.get(providerId);
    const environmentKey = providerId === "anthropic" ? config.anthropicApiKey : undefined;
    const apiKeySource =
      storedKey !== undefined ? "credentials" : environmentKey !== undefined ? "environment" : null;
    return {
      apiKeyConfigured: apiKeySource !== null,
      apiKeySource,
      mock: modelSetup.mock,
      modelId: modelSetup.modelId,
      models: modelSetup.modelRuntime.getModels(providerId).map((model) => ({
        contextWindow: model.contextWindow,
        id: model.id,
        maxTokens: model.maxTokens,
        name: model.name || model.id,
        reasoning: model.reasoning,
        thinkingLevels: model.reasoning ? THINKING_LEVELS : ["off"],
      })),
      providerId,
      providerName: provider?.name ?? providerId,
      providers: modelSetup.modelRuntime
        .getProviders()
        .filter(
          (candidate) => candidate.auth.apiKey !== undefined || candidate.auth.oauth !== undefined,
        )
        .map((candidate) => ({
          id: candidate.id,
          modelCount: candidate.getModels().length,
          name: candidate.name,
        }))
        .filter((candidate) => candidate.modelCount > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
      thinkingLevel: storedThinkingLevel(database),
    };
  }

  public listCustomProviders(): CustomProviderView[] {
    const { credentials, database, modelSetup } = this.options;
    return database.listCustomProviders().map((record) => ({
      baseUrl: record.baseUrl,
      configured:
        !record.requiresApiKey || modelSetup.mock || credentials.get(record.id) !== undefined,
      id: record.id,
      models: record.models,
      name: record.name,
      protocol: record.protocol,
      requiresApiKey: record.requiresApiKey,
    }));
  }

  public async initializeCustomProviders(): Promise<void> {
    const { credentials, database, modelSetup } = this.options;
    for (const record of database.listCustomProviders()) {
      const apiKey = credentials.get(record.id);
      this.registerCustomProvider(record, apiKey);
      if (apiKey !== undefined) {
        await modelSetup.modelRuntime.setRuntimeApiKey(record.id, apiKey);
      }
    }
  }

  public async saveCustomProvider(input: SaveCustomProviderInput): Promise<CustomProviderView> {
    const { credentials, database, modelSetup } = this.options;
    const name = input.name.trim();
    if (name === "" || name.length > 120) {
      throw new ModelSettingsError("Provider 名称必须为 1-120 个字符");
    }
    let baseUrl: string;
    try {
      const url = new URL(input.baseUrl.trim());
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw new Error("invalid");
      }
      baseUrl = url.toString().replace(/\/$/u, "");
    } catch {
      throw new ModelSettingsError("Base URL 必须是有效的 HTTP(S) 地址");
    }
    const models = normalizeCustomModels(input.models);
    const apiKey = input.apiKey?.trim();
    if (input.requiresApiKey && (apiKey === undefined || apiKey === "")) {
      throw new ModelSettingsError("该 Provider 需要 API Key");
    }
    const id = `custom:${randomUUID()}`;
    const record: CustomProviderRecord = {
      baseUrl,
      createdAt: Date.now(),
      id,
      models,
      name,
      protocol: input.protocol,
      requiresApiKey: input.requiresApiKey,
      updatedAt: Date.now(),
    };
    this.registerCustomProvider(record, apiKey);
    if (apiKey !== undefined && apiKey !== "") {
      await modelSetup.modelRuntime.setRuntimeApiKey(id, apiKey);
      await credentials.set(id, apiKey);
    }
    database.createCustomProvider(record);
    return this.listCustomProviders().find((item) => item.id === id) as CustomProviderView;
  }

  public async removeCustomProvider(id: string): Promise<void> {
    const { credentials, database, modelSetup } = this.options;
    if (database.getCustomProvider(id) === null) {
      throw new ModelSettingsError("自定义 Provider 不存在");
    }
    modelSetup.modelRuntime.unregisterProvider(id);
    await credentials.delete(id);
    database.deleteCustomProvider(id);
  }

  private registerCustomProvider(record: CustomProviderRecord, apiKey?: string): void {
    this.options.modelSetup.modelRuntime.registerProvider(record.id, {
      ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      api: record.protocol,
      authHeader: record.requiresApiKey,
      baseUrl: record.baseUrl,
      models: record.models.map((model) => ({
        api: record.protocol,
        contextWindow: model.contextWindow,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        id: model.id,
        input: ["text"],
        maxTokens: model.maxTokens,
        name: model.name,
        reasoning: model.reasoning,
      })),
      name: record.name,
    });
  }

  public modelsFor(providerId: string): ModelChoices[] {
    const models = this.options.modelSetup.modelRuntime.getModels(providerId);
    if (models.length === 0) throw new ModelSettingsError(`未知 Provider "${providerId}"`);
    return models.map((model) => ({
      contextWindow: model.contextWindow,
      ...(model.cost !== undefined && (model.cost.input > 0 || model.cost.output > 0)
        ? { cost: { input: model.cost.input, output: model.cost.output } }
        : {}),
      id: model.id,
      maxTokens: model.maxTokens,
      name: model.name || model.id,
      reasoning: model.reasoning,
      thinkingLevels: model.reasoning ? THINKING_LEVELS : ["off"],
    }));
  }

  public pricingFor(providerId: string, modelId: string): { input: number; output: number } | null {
    const model = this.options.modelSetup.modelRuntime.getModel(providerId, modelId);
    if (model?.cost === undefined) return null;
    return model.cost.input > 0 || model.cost.output > 0
      ? { input: model.cost.input, output: model.cost.output }
      : null;
  }

  public catalog(): ModelCatalogView {
    const { config, credentials, database, modelSetup } = this.options;
    const providers = modelSetup.modelRuntime
      .getProviders()
      .filter(
        (provider) =>
          (provider.auth.apiKey !== undefined || provider.auth.oauth !== undefined) &&
          provider.getModels().length > 0,
      )
      .map((provider) => ({
        configured:
          modelSetup.mock ||
          credentials.get(provider.id) !== undefined ||
          (provider.id === "anthropic" && config.anthropicApiKey !== undefined) ||
          database.getCustomProvider(provider.id)?.requiresApiKey === false,
        id: provider.id,
        models: provider.getModels().map((model) => ({
          contextWindow: model.contextWindow,
          ...(model.cost !== undefined && (model.cost.input > 0 || model.cost.output > 0)
            ? { cost: { input: model.cost.input, output: model.cost.output } }
            : {}),
          id: model.id,
          maxTokens: model.maxTokens,
          name: model.name || model.id,
          reasoning: model.reasoning,
          thinkingLevels: model.reasoning ? THINKING_LEVELS : ["off"],
        })),
        name: provider.name,
        oauthSupported: provider.auth.oauth !== undefined,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      default: {
        modelId: modelSetup.modelId,
        providerId: modelSetup.providerId,
        thinkingLevel: storedThinkingLevel(database),
      },
      providers,
    };
  }

  public async validateSelection(
    providerId: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<void> {
    const { config, credentials, database, modelSetup } = this.options;
    const model = modelSetup.modelRuntime.getModel(providerId, modelId);
    if (model === undefined) throw new ModelSettingsError(`未知模型 "${providerId}/${modelId}"`);
    if (!THINKING_LEVELS.includes(thinkingLevel)) {
      throw new ModelSettingsError(`未知推理强度 "${thinkingLevel}"`);
    }
    if (!modelSetup.mock) {
      let configured =
        credentials.get(providerId) !== undefined ||
        (providerId === "anthropic" && config.anthropicApiKey !== undefined) ||
        database.getCustomProvider(providerId)?.requiresApiKey === false;
      if (
        !configured &&
        modelSetup.modelRuntime.getProvider(providerId)?.auth.oauth !== undefined
      ) {
        configured =
          (await modelSetup.modelRuntime.getAuth(providerId).catch(() => undefined)) !== undefined;
      }
      if (!configured) throw new ModelSettingsError("Provider 尚未配置 API Key 或 OAuth 登录");
    }
  }

  public async hydrateCredentials(): Promise<void> {
    const { config, credentials, modelSetup } = this.options;
    if (modelSetup.mock) return;
    for (const provider of modelSetup.modelRuntime.getProviders()) {
      const apiKey =
        credentials.get(provider.id) ??
        (provider.id === "anthropic" ? config.anthropicApiKey : undefined);
      if (apiKey !== undefined) {
        await modelSetup.modelRuntime.setRuntimeApiKey(provider.id, apiKey);
      }
    }
  }

  /** 自定义 Provider 注册完成后，重新应用持久化的默认选择。 */
  public async restoreStoredSelection(): Promise<void> {
    const { config, credentials, database, modelSetup } = this.options;
    const stored = readStoredModelSelection(database, config, credentials);
    const model = modelSetup.modelRuntime.getModel(stored.providerId, stored.modelId);
    if (model === undefined) return;
    await modelSetup.modelRuntime.setRuntimeApiKey(
      stored.providerId,
      stored.mock ? "mock-key" : (stored.apiKey as string),
    );
    modelSetup.model = model;
    modelSetup.modelId = stored.modelId;
    modelSetup.providerId = stored.providerId;
    modelSetup.mock = stored.mock;
    config.model = stored.modelId;
    config.mockModel = stored.mock;
  }

  public async testConnection(input: {
    apiKey?: string | undefined;
    modelId: string;
    providerId: string;
  }): Promise<{ latencyMs: number; model: string }> {
    const { config, credentials, modelSetup } = this.options;
    const model = modelSetup.modelRuntime.getModel(input.providerId, input.modelId);
    if (model === undefined) {
      throw new ModelSettingsError(`未知模型 "${input.providerId}/${input.modelId}"`);
    }
    const apiKey =
      input.apiKey?.trim() ||
      credentials.get(input.providerId) ||
      (input.providerId === "anthropic" ? config.anthropicApiKey : undefined);
    if (modelSetup.mock && apiKey === undefined) {
      throw new ModelSettingsError("尚未接入真实模型，无法执行连接测试");
    }
    if (apiKey === undefined) throw new ModelSettingsError("Provider 尚未配置 API Key");

    const started = Date.now();
    const signal = AbortSignal.timeout(20_000);
    try {
      const result = await modelSetup.modelRuntime.completeSimple(
        model,
        {
          messages: [
            {
              content: [{ text: "Reply with OK.", type: "text" }],
              role: "user",
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey, maxTokens: 8, signal },
      );
      if (result.errorMessage !== undefined) throw new Error(result.errorMessage);
      return { latencyMs: Date.now() - started, model: model.name || model.id };
    } catch (error: unknown) {
      if (error instanceof ModelSettingsError) throw error;
      throw new ModelSettingsError(error instanceof Error ? error.message : "连接测试失败");
    }
  }

  public async save(input: SaveModelSettingsInput): Promise<ModelSettingsView> {
    const { config, credentials, database, modelSetup } = this.options;
    const providerId = input.providerId.trim();
    const modelId = input.modelId.trim();
    if (providerId === "" || providerId.length > 64) {
      throw new ModelSettingsError("Provider 无效");
    }
    if (modelId === "" || modelId.length > 200) {
      throw new ModelSettingsError("模型 ID 无效");
    }
    const thinkingLevel = input.thinkingLevel ?? storedThinkingLevel(database);
    if (!THINKING_LEVELS.includes(thinkingLevel)) {
      throw new ModelSettingsError("推理强度无效");
    }

    const typedKey = input.apiKey?.trim();
    if (typedKey !== undefined && typedKey.length > 500) {
      throw new ModelSettingsError("API Key 过长");
    }
    const apiKey =
      input.clearApiKey === true
        ? providerId === "anthropic"
          ? config.anthropicApiKey
          : undefined
        : ((typedKey === undefined || typedKey === "" ? undefined : typedKey) ??
          credentials.get(providerId) ??
          (providerId === "anthropic" ? config.anthropicApiKey : undefined));
    if (!input.mock && apiKey === undefined) {
      throw new ModelSettingsError("接入真实模型前需要填写 API Key");
    }

    const model = modelSetup.modelRuntime.getModel(providerId, modelId);
    if (model === undefined) {
      const available = modelSetup.modelRuntime
        .getModels(providerId)
        .map((candidate) => candidate.id)
        .slice(0, 24)
        .join(", ");
      throw new ModelSettingsError(`未知模型 "${providerId}/${modelId}"。可用模型: ${available}`);
    }
    await modelSetup.modelRuntime.setRuntimeApiKey(
      providerId,
      input.mock ? "mock-key" : (apiKey as string),
    );

    if (input.clearApiKey === true) {
      await credentials.delete(providerId);
    } else if (typedKey !== undefined && typedKey !== "") {
      await credentials.set(providerId, typedKey);
    }
    database.setSetting(PROVIDER_KEY, providerId);
    database.setSetting(MODEL_KEY, modelId);
    database.setSetting(THINKING_KEY, thinkingLevel);
    database.setSetting(MOCK_KEY, input.mock ? "1" : "0");
    config.model = modelId;
    config.mockModel = input.mock;
    modelSetup.model = model;
    modelSetup.modelId = modelId;
    modelSetup.providerId = providerId;
    modelSetup.mock = input.mock;
    await this.hydrateCredentials();
    return this.get();
  }
}
