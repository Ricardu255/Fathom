import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FILE_VERSION = 1;
const MAX_KEY_LENGTH = 500;
const MAX_PROVIDER_ID_LENGTH = 64;

export interface CredentialStoreLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

interface CredentialFile {
  apiKeys: Record<string, string>;
  version: number;
}

export class CredentialStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

/**
 * API Key 的落盘位置：独立文件，不进 SQLite。
 *
 * 密钥单独存放，是因为 SQLite 会被整体备份、复制去复现问题、甚至随数据目录一起同步，
 * 而密钥不该跟着数据流动。文件权限尽力设为 0600；Windows 上 POSIX 权限位不生效，
 * 这条防线在那里不成立，剩下的是「文件位于用户数据目录内，不随仓库分发」。
 */
export class ProviderCredentialStore {
  private readonly keys = new Map<string, string>();
  private loaded = false;

  public constructor(
    private readonly filePath: string,
    private readonly logger?: CredentialStoreLogger,
  ) {}

  public get size(): number {
    return this.keys.size;
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const apiKeys = isRecord(parsed) && isRecord(parsed.apiKeys) ? parsed.apiKeys : {};
      for (const [providerId, apiKey] of Object.entries(apiKeys)) {
        const entry = normalizeEntry(providerId, apiKey);
        if (entry !== undefined) this.keys.set(entry.providerId, entry.apiKey);
      }
    } catch (error: unknown) {
      // 解析失败不能静默从空开始，否则用户的密钥会凭空消失且没有任何线索。
      // 改名保留现场，让用户还能从隔离文件里把 Key 捞回来。
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      await rename(this.filePath, quarantine).catch(() => undefined);
      this.logger?.warn(
        { err: error, path: this.filePath, quarantine },
        "凭据文件无法解析，已隔离并从空开始",
      );
    }
  }

  public get(providerId: string): string | undefined {
    const value = this.keys.get(providerId);
    return value === undefined || value === "" ? undefined : value;
  }

  public async set(providerId: string, apiKey: string): Promise<void> {
    const entry = normalizeEntry(providerId, apiKey);
    if (entry === undefined) throw new CredentialStoreError("API Key 无效");
    this.keys.set(entry.providerId, entry.apiKey);
    await this.flush();
  }

  public async delete(providerId: string): Promise<void> {
    if (!this.keys.delete(providerId)) return;
    await this.flush();
  }

  /** 把旧版落在 SQLite settings 里的明文密钥搬进来；返回真正写入的条数。 */
  public async adopt(entries: ReadonlyMap<string, string>): Promise<number> {
    let adopted = 0;
    for (const [providerId, apiKey] of entries) {
      const entry = normalizeEntry(providerId, apiKey);
      if (entry === undefined || this.keys.has(entry.providerId)) continue;
      this.keys.set(entry.providerId, entry.apiKey);
      adopted += 1;
    }
    if (adopted > 0) await this.flush();
    return adopted;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const snapshot: CredentialFile = {
      apiKeys: Object.fromEntries(this.keys),
      version: FILE_VERSION,
    };
    // 先写临时文件再 rename：写一半崩溃时不会留下半个凭据文件。
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

function normalizeEntry(
  providerId: string,
  apiKey: unknown,
): { apiKey: string; providerId: string } | undefined {
  if (
    providerId === "" ||
    providerId.length > MAX_PROVIDER_ID_LENGTH ||
    typeof apiKey !== "string"
  ) {
    return undefined;
  }
  const trimmed = apiKey.trim();
  if (trimmed === "" || trimmed.length > MAX_KEY_LENGTH) return undefined;
  return { apiKey: trimmed, providerId };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
