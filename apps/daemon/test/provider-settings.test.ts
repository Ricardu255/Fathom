import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type HarnessConfig, loadConfig } from "../src/config";
import { createPiModelSetup } from "../src/pi/model";
import { ProviderCredentialStore } from "../src/services/provider-credential-store";
import {
  ModelSettingsError,
  migrateLegacyCredentials,
  ProviderSettingsService,
  readStoredModelSelection,
} from "../src/services/provider-settings-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let config: HarnessConfig;
let credentials: ProviderCredentialStore;
let database: HarnessDatabase;
let service: ProviderSettingsService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-provider-settings-"));
  config = loadConfig({
    HARNESS_DATA_DIR: join(root, "data"),
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: join(root, "workspace"),
  });
  database = new HarnessDatabase(join(config.dataDir, "harness.sqlite"));
  credentials = new ProviderCredentialStore(join(config.dataDir, "credentials.json"));
  await credentials.load();
  const setup = await createPiModelSetup(config);
  service = new ProviderSettingsService({ config, credentials, database, modelSetup: setup });
});

after(async () => {
  database.close();
  await rm(root, { force: true, recursive: true });
});

test("默认模型设置不回传密钥，并列出当前 Provider 的模型", () => {
  const view = service.get();
  assert.equal(view.providerId, "anthropic");
  assert.equal(view.modelId, config.model);
  assert.equal(view.mock, true);
  assert.equal(view.apiKeyConfigured, false);
  assert.equal(view.apiKeySource, null);
  assert.ok(view.providers.some((provider) => provider.id === "anthropic"));
  assert.ok(view.models.some((model) => model.id === config.model));
  assert.equal("apiKey" in view, false);
});

test("模型目录包含尺寸、推理能力与默认选择", () => {
  const catalog = service.catalog();
  const provider = catalog.providers.find((item) => item.id === "anthropic");
  assert.ok(provider !== undefined);
  const model = provider.models.find((item) => item.id === config.model);
  assert.ok(model !== undefined);
  assert.ok(model.contextWindow > 0);
  assert.ok(model.maxTokens > 0);
  assert.deepEqual(catalog.default, {
    modelId: config.model,
    providerId: "anthropic",
    thinkingLevel: "medium",
  });
  assert.ok(model.thinkingLevels.includes("off"));
});

test("未配置真实 Key 时连接测试不会发起网络请求", async () => {
  await assert.rejects(
    () => service.testConnection({ modelId: config.model, providerId: "anthropic" }),
    /尚未接入真实模型/,
  );
});

test("可以注册、列出并删除自定义 Provider", async () => {
  const created = await service.saveCustomProvider({
    apiKey: "sk-custom-test",
    baseUrl: "https://api.example.com/v1",
    models: [
      {
        contextWindow: 64_000,
        id: "local-model",
        maxTokens: 8_000,
        name: "Local Model",
        reasoning: true,
      },
    ],
    name: "本地兼容服务",
    protocol: "openai-completions",
    requiresApiKey: true,
  });
  assert.equal(created.configured, true);
  assert.equal(created.models[0]?.id, "local-model");
  assert.ok(service.listCustomProviders().some((item) => item.id === created.id));
  assert.ok(
    service
      .catalog()
      .providers.some(
        (provider) =>
          provider.id === created.id && provider.models.some((model) => model.id === "local-model"),
      ),
  );

  await service.removeCustomProvider(created.id);
  assert.equal(
    service.listCustomProviders().some((item) => item.id === created.id),
    false,
  );
  assert.equal(
    service.catalog().providers.some((item) => item.id === created.id),
    false,
  );
});

test("真实模型缺少 API Key 时拒绝保存", async () => {
  await assert.rejects(
    () =>
      service.save({
        mock: false,
        modelId: config.model,
        providerId: "anthropic",
      }),
    ModelSettingsError,
  );
  assert.equal(service.get().mock, true);
});

test("API Key 持久化但视图只暴露配置状态", async () => {
  const view = await service.save({
    apiKey: "sk-local-test",
    mock: false,
    modelId: config.model,
    providerId: "anthropic",
  });
  assert.equal(view.mock, false);
  assert.equal(view.apiKeyConfigured, true);
  assert.equal(view.apiKeySource, "credentials");
  assert.equal("apiKey" in view, false);
  assert.equal(JSON.stringify(view).includes("sk-local-test"), false);

  // 密钥只落凭据文件，SQLite 里不能出现明文。
  assert.equal(database.getSetting("model_api_key:anthropic"), null);
  assert.equal(credentials.get("anthropic"), "sk-local-test");
  const settingsDump = JSON.stringify(database.getSettings());
  assert.equal(settingsDump.includes("sk-local-test"), false);

  const stored = readStoredModelSelection(database, config, credentials);
  assert.equal(stored.providerId, "anthropic");
  assert.equal(stored.modelId, config.model);
  assert.equal(stored.mock, false);
  assert.equal(stored.apiKey, "sk-local-test");
});

test("未知模型不会改写已保存配置", async () => {
  await assert.rejects(
    () =>
      service.save({
        apiKey: "sk-local-test",
        mock: false,
        modelId: "definitely-not-a-model",
        providerId: "anthropic",
      }),
    ModelSettingsError,
  );
  const stored = readStoredModelSelection(database, config, credentials);
  assert.equal(stored.modelId, config.model);
  assert.equal(stored.mock, false);
});

test("Mock 模式下可以清除已保存的 Key", async () => {
  const view = await service.save({
    clearApiKey: true,
    mock: true,
    modelId: config.model,
    providerId: "anthropic",
  });
  assert.equal(view.mock, true);
  assert.equal(view.apiKeyConfigured, false);
  assert.equal(view.apiKeySource, null);
  const stored = readStoredModelSelection(database, config, credentials);
  assert.equal(stored.apiKey, undefined);
  assert.equal(stored.mock, true);
});

test("环境变量提供的 Key 标记为 environment 且不会被清除", async () => {
  const envRoot = await mkdtemp(join(root, "env-key-"));
  const envConfig = loadConfig({
    HARNESS_ANTHROPIC_API_KEY: "sk-from-environment",
    HARNESS_DATA_DIR: join(envRoot, "data"),
    HARNESS_MOCK_MODEL: "0",
    HARNESS_WORKSPACE: join(envRoot, "workspace"),
  });
  const envDatabase = new HarnessDatabase(join(envConfig.dataDir, "harness.sqlite"));
  const envCredentials = new ProviderCredentialStore(join(envConfig.dataDir, "credentials.json"));
  await envCredentials.load();
  try {
    const envSetup = await createPiModelSetup(envConfig, {
      apiKey: "sk-from-environment",
      mock: false,
    });
    const envService = new ProviderSettingsService({
      config: envConfig,
      credentials: envCredentials,
      database: envDatabase,
      modelSetup: envSetup,
    });
    const initial = envService.get();
    assert.equal(initial.apiKeyConfigured, true);
    assert.equal(initial.apiKeySource, "environment");

    const cleared = await envService.save({
      clearApiKey: true,
      mock: false,
      modelId: envConfig.model,
      providerId: "anthropic",
    });
    assert.equal(cleared.apiKeySource, "environment");
    assert.equal(cleared.apiKeyConfigured, true);
  } finally {
    envDatabase.close();
    await rm(envRoot, { force: true, recursive: true });
  }
});

test("缺少 Key 时即使环境要求真实模型也回退 Mock", async () => {
  const fallbackRoot = await mkdtemp(join(root, "fallback-"));
  const fallbackConfig = loadConfig({
    HARNESS_DATA_DIR: join(fallbackRoot, "data"),
    HARNESS_MOCK_MODEL: "0",
    HARNESS_WORKSPACE: join(fallbackRoot, "workspace"),
  });
  const fallbackDatabase = new HarnessDatabase(join(fallbackConfig.dataDir, "harness.sqlite"));
  const fallbackCredentials = new ProviderCredentialStore(
    join(fallbackConfig.dataDir, "credentials.json"),
  );
  await fallbackCredentials.load();
  try {
    const stored = readStoredModelSelection(fallbackDatabase, fallbackConfig, fallbackCredentials);
    assert.equal(stored.apiKey, undefined);
    assert.equal(stored.mock, true);
  } finally {
    fallbackDatabase.close();
    await rm(fallbackRoot, { force: true, recursive: true });
  }
});

test("modelsFor 拒绝未知 Provider", () => {
  assert.throws(() => service.modelsFor("not-a-provider"), ModelSettingsError);
});

test("旧版明文 Key 会迁移到凭据文件并从数据库删除", async () => {
  const legacyRoot = await mkdtemp(join(root, "legacy-"));
  const legacyConfig = loadConfig({
    HARNESS_DATA_DIR: join(legacyRoot, "data"),
    HARNESS_MOCK_MODEL: "0",
    HARNESS_WORKSPACE: join(legacyRoot, "workspace"),
  });
  const legacyDatabase = new HarnessDatabase(join(legacyConfig.dataDir, "harness.sqlite"));
  const legacyCredentials = new ProviderCredentialStore(
    join(legacyConfig.dataDir, "credentials.json"),
  );
  await legacyCredentials.load();
  try {
    legacyDatabase.setSetting("model_provider", "anthropic");
    legacyDatabase.setSetting("model_api_key:anthropic", "sk-legacy-plaintext");
    legacyDatabase.setSetting("model_mock", "0");

    assert.equal(await migrateLegacyCredentials(legacyDatabase, legacyCredentials), 1);
    assert.equal(legacyDatabase.getSetting("model_api_key:anthropic"), null);
    assert.equal(legacyCredentials.get("anthropic"), "sk-legacy-plaintext");

    // 迁移后仍要能读到原来的选择，否则升级会让用户掉回 Mock。
    const stored = readStoredModelSelection(legacyDatabase, legacyConfig, legacyCredentials);
    assert.equal(stored.apiKey, "sk-legacy-plaintext");
    assert.equal(stored.mock, false);

    // 再跑一次不应重复迁移。
    assert.equal(await migrateLegacyCredentials(legacyDatabase, legacyCredentials), 0);
  } finally {
    legacyDatabase.close();
    await rm(legacyRoot, { force: true, recursive: true });
  }
});
