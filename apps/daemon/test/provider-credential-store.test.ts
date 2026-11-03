import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import {
  CredentialStoreError,
  ProviderCredentialStore,
} from "../src/services/provider-credential-store";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-credentials-"));
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("写入后重新加载仍然可读，文件是带版本号的 JSON", async () => {
  const path = join(root, "reload", "credentials.json");
  const store = new ProviderCredentialStore(path);
  await store.load();
  await store.set("anthropic", "  sk-reload  ");

  const reloaded = new ProviderCredentialStore(path);
  await reloaded.load();
  assert.equal(reloaded.get("anthropic"), "sk-reload");

  const payload = JSON.parse(await readFile(path, "utf8")) as {
    apiKeys: Record<string, string>;
    version: number;
  };
  assert.equal(payload.version, 1);
  assert.deepEqual(payload.apiKeys, { anthropic: "sk-reload" });
});

test("删除会同步到文件", async () => {
  const path = join(root, "delete", "credentials.json");
  const store = new ProviderCredentialStore(path);
  await store.load();
  await store.set("anthropic", "sk-delete");
  await store.delete("anthropic");

  const reloaded = new ProviderCredentialStore(path);
  await reloaded.load();
  assert.equal(reloaded.get("anthropic"), undefined);
  assert.equal(reloaded.size, 0);
});

test("损坏的凭据文件被隔离，而不是被静默清空", async () => {
  const path = join(root, "corrupt", "credentials.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ 不是 JSON", "utf8");

  const warnings: string[] = [];
  const store = new ProviderCredentialStore(path, {
    warn: (_details, message) => warnings.push(message),
  });
  await store.load();

  assert.equal(store.get("anthropic"), undefined);
  assert.equal(warnings.length, 1);
  const quarantined = (await readdir(dirname(path))).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);
});

test("adopt 不会覆盖文件里已有的 Key", async () => {
  const path = join(root, "adopt", "credentials.json");
  const store = new ProviderCredentialStore(path);
  await store.load();
  await store.set("anthropic", "sk-current");

  const adopted = await store.adopt(
    new Map([
      ["anthropic", "sk-legacy"],
      ["openai", "sk-openai"],
    ]),
  );
  assert.equal(adopted, 1);
  assert.equal(store.get("anthropic"), "sk-current");
  assert.equal(store.get("openai"), "sk-openai");
});

test("空 Key 与非法 Provider 被拒绝", async () => {
  const store = new ProviderCredentialStore(join(root, "invalid", "credentials.json"));
  await store.load();
  await assert.rejects(() => store.set("anthropic", "   "), CredentialStoreError);
  await assert.rejects(() => store.set("", "sk-x"), CredentialStoreError);
  await assert.rejects(() => store.set("p", "x".repeat(501)), CredentialStoreError);
});
