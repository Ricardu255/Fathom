import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config";
import { createPiModelSetup } from "../src/pi/model";
import { ProviderOAuthError, ProviderOAuthService } from "../src/services/provider-oauth-service";

let oauth: ProviderOAuthService;
let runtime: ModelRuntime;
let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "fathom-oauth-"));
  const config = loadConfig({
    HARNESS_DATA_DIR: join(root, "data"),
    HARNESS_MOCK_MODEL: "1",
    HARNESS_WORKSPACE: join(root, "workspace"),
  });
  const setup = await createPiModelSetup(config);
  runtime = setup.modelRuntime;
  oauth = new ProviderOAuthService(runtime);
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("OAuth Provider 列表只包含支持 OAuth 的 Provider", async () => {
  const providers = await oauth.listProviders();
  assert.ok(Array.isArray(providers));
  for (const provider of providers) {
    assert.equal(runtime.getProvider(provider.id)?.auth.oauth !== undefined, true);
    assert.ok(provider.name.length > 0);
  }
});

test("未知 Provider 与不支持 OAuth 的 Provider 会被拒绝", async () => {
  await assert.rejects(
    () => oauth.start("missing-provider"),
    (error: unknown) => error instanceof ProviderOAuthError && error.code === "NOT_FOUND",
  );
  const unsupported = runtime.getProviders().find((provider) => provider.auth.oauth === undefined);
  assert.ok(unsupported !== undefined);
  await assert.rejects(
    () => oauth.start(unsupported.id),
    (error: unknown) => error instanceof ProviderOAuthError && error.code === "NOT_SUPPORTED",
  );
});

test("不存在的登录会话会返回 NOT_FOUND", () => {
  assert.throws(
    () => oauth.get("missing-login"),
    (error: unknown) => error instanceof ProviderOAuthError && error.code === "NOT_FOUND",
  );
});
