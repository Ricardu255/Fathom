import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  defaultStoragePaths,
  isPathInside,
  prepareStorage,
  readStorageConfig,
  storageConfigPath,
  writeStorageConfig,
} from "../src/storage";

let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "fathom-storage-"));
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("默认数据与缓存目录位于用户数据目录下", () => {
  const userData = join(root, "defaults");
  const paths = defaultStoragePaths(userData);
  assert.equal(paths.dataDir, join(userData, "data"));
  assert.equal(paths.cacheDir, join(userData, "cache"));
});

test("存储配置可持久化，损坏配置回退默认值", async () => {
  const userData = join(root, "config");
  const dataDir = join(root, "custom-data");
  writeStorageConfig(userData, { cacheDir: join(root, "custom-cache"), dataDir });
  const loaded = readStorageConfig(userData);
  assert.equal(loaded.dataDir, dataDir);
  assert.equal(loaded.cacheDir, join(root, "custom-cache"));

  await writeFile(storageConfigPath(userData), "{broken", "utf8");
  assert.deepEqual(readStorageConfig(userData), {});
});

test("首次启动前会把旧数据复制到新目录并清除迁移标记", async () => {
  const userData = join(root, "migrate");
  const oldData = join(root, "old-data");
  const newData = join(root, "new-data");
  await mkdir(join(oldData, "sessions"), { recursive: true });
  await writeFile(join(oldData, "sessions", "demo.jsonl"), '{"ok":true}\n', "utf8");
  await mkdir(join(oldData, "literature"), { recursive: true });
  await writeFile(join(oldData, "literature", "paper.txt"), "paper", "utf8");
  writeStorageConfig(userData, { dataDir: newData, migrateDataFrom: oldData });

  const prepared = prepareStorage(userData);
  assert.equal(prepared.migrationError, null);
  assert.equal(prepared.dataDir, newData);
  assert.equal(await readFile(join(newData, "sessions", "demo.jsonl"), "utf8"), '{"ok":true}\n');
  assert.equal(await readFile(join(newData, "literature", "paper.txt"), "utf8"), "paper");
  await access(prepared.cacheDir);

  const config = readStorageConfig(userData);
  assert.equal(config.dataDir, newData);
  assert.equal(config.migrateDataFrom, undefined);
});

test("迁移失败时回退旧目录并保留迁移标记", async () => {
  const userData = join(root, "migration-failure");
  const oldData = join(root, "fallback-old");
  const invalidTarget = join(root, "fallback-target-is-a-file");
  await mkdir(oldData, { recursive: true });
  await writeFile(join(oldData, "keep.txt"), "keep", "utf8");
  await writeFile(invalidTarget, "not a directory", "utf8");
  writeStorageConfig(userData, { dataDir: invalidTarget, migrateDataFrom: oldData });

  const prepared = prepareStorage(userData);
  assert.equal(prepared.dataDir, oldData);
  assert.notEqual(prepared.migrationError, null);
  const config = readStorageConfig(userData);
  assert.equal(config.migrateDataFrom, oldData);
});

test("路径包含检查拒绝相邻但不同前缀", () => {
  assert.equal(isPathInside("C:/Fathom/data", "C:/Fathom/data/sessions"), true);
  assert.equal(isPathInside("C:/Fathom/data", "C:/Fathom/data2"), false);
  assert.equal(isPathInside("/home/me/data", "/home/me/data2"), false);
});
