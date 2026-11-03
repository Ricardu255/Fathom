import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { resolveWorkspacePath } from "@harness/policy";
import { listWorkspaceEntries, type WorkspaceEntry } from "@harness/tools";

const MAX_FILE_BYTES = 1024 * 1024;

export class WorkspaceServiceError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_FOUND" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceServiceError";
  }
}

export interface WorkspaceFileView {
  content: string;
  path: string;
  size: number;
}

export class WorkspaceService {
  public constructor(
    private readonly options: {
      protectedPaths: readonly string[];
    },
  ) {}

  public async list(
    workspaceRoot: string,
    path = ".",
    depth = 4,
  ): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    return listWorkspaceEntries({
      depth,
      path,
      protectedPaths: this.options.protectedPaths,
      workspaceRoot,
    });
  }

  public async read(workspaceRoot: string, path: string): Promise<WorkspaceFileView> {
    const absolute = await this.resolve(workspaceRoot, path, false);
    const info = await stat(absolute);
    if (!info.isFile()) throw new WorkspaceServiceError("INVALID", "目标不是文件");
    if (info.size > MAX_FILE_BYTES) {
      throw new WorkspaceServiceError("TOO_LARGE", "文件超过 1MB，暂不支持在编辑器中打开");
    }
    const buffer = await readFile(absolute);
    if (buffer.includes(0)) {
      throw new WorkspaceServiceError("INVALID", "二进制文件不能作为文本打开");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new WorkspaceServiceError("INVALID", "文件不是有效的 UTF-8 文本");
    }
    return { content, path: normalizeRelative(workspaceRoot, absolute), size: info.size };
  }

  public async delete(workspaceRoot: string, path: string): Promise<void> {
    const absolute = await this.resolve(workspaceRoot, path, false);
    const info = await stat(absolute);
    if (!info.isFile()) throw new WorkspaceServiceError("INVALID", "目标不是文件");
    await rm(absolute, { force: true });
  }

  public async write(
    workspaceRoot: string,
    path: string,
    content: string,
  ): Promise<WorkspaceFileView> {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new WorkspaceServiceError("TOO_LARGE", "文件内容不能超过 1MB");
    }
    const absolute = await this.resolve(workspaceRoot, path, true);
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, absolute);
    } finally {
      await rm(temporary, { force: true });
    }
    return this.read(workspaceRoot, path);
  }

  private async resolve(
    workspaceRoot: string,
    path: string,
    allowMissing: boolean,
  ): Promise<string> {
    try {
      return await resolveWorkspacePath({
        ...(allowMissing ? { allowMissing: true } : {}),
        path,
        protectedPaths: this.options.protectedPaths,
        workspaceRoot,
      });
    } catch (error: unknown) {
      throw new WorkspaceServiceError(
        "INVALID",
        error instanceof Error ? error.message : "无法访问工作区路径",
      );
    }
  }
}

function normalizeRelative(workspaceRoot: string, absolute: string): string {
  return relative(workspaceRoot, absolute).split("\\").join("/");
}
