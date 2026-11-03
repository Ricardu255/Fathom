import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface StorageConfig {
  cacheDir?: string;
  dataDir?: string;
  migrateDataFrom?: string;
}

export interface StoragePaths {
  cacheDir: string;
  dataDir: string;
  migrationError: string | null;
}

const CONFIG_FILE = "storage.json";

export function storageConfigPath(userData: string): string {
  return join(userData, CONFIG_FILE);
}

export function readStorageConfig(userData: string): StorageConfig {
  try {
    const parsed = JSON.parse(readFileSync(storageConfigPath(userData), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(isUsablePath(record.cacheDir) ? { cacheDir: resolve(record.cacheDir) } : {}),
      ...(isUsablePath(record.dataDir) ? { dataDir: resolve(record.dataDir) } : {}),
      ...(isUsablePath(record.migrateDataFrom)
        ? { migrateDataFrom: resolve(record.migrateDataFrom) }
        : {}),
    };
  } catch {
    return {};
  }
}

export function writeStorageConfig(userData: string, config: StorageConfig): void {
  mkdirSync(userData, { recursive: true });
  const target = storageConfigPath(userData);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function defaultStoragePaths(userData: string): Pick<StoragePaths, "cacheDir" | "dataDir"> {
  return {
    cacheDir: join(userData, "cache"),
    dataDir: join(userData, "data"),
  };
}

/** 应用启动前解析路径；数据迁移失败时回退旧目录，保证客户端仍能打开。 */
export function prepareStorage(userData: string): StoragePaths {
  const config = readStorageConfig(userData);
  const defaults = defaultStoragePaths(userData);
  const dataDir = config.dataDir ?? defaults.dataDir;
  const cacheDir = config.cacheDir ?? defaults.cacheDir;
  mkdirSync(cacheDir, { recursive: true });
  let migrationError: string | null = null;
  let activeDataDir = dataDir;

  if (config.migrateDataFrom !== undefined && config.migrateDataFrom !== dataDir) {
    const source = config.migrateDataFrom;
    if (existsSync(source)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        cpSync(source, dataDir, { force: true, recursive: true });
        const { migrateDataFrom: _migrate, ...next } = config;
        writeStorageConfig(userData, next);
      } catch (error: unknown) {
        migrationError = error instanceof Error ? error.message : "数据迁移失败";
        activeDataDir = source;
      }
    } else {
      const { migrateDataFrom: _migrate, ...next } = config;
      writeStorageConfig(userData, next);
    }
  }

  mkdirSync(activeDataDir, { recursive: true });
  return { cacheDir, dataDir: activeDataDir, migrationError };
}

export function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  if (normalizedParent === normalizedChild) return true;
  return normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

export function removeStorageConfig(userData: string): void {
  rmSync(storageConfigPath(userData), { force: true });
}

function isUsablePath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && isAbsolute(value);
}
