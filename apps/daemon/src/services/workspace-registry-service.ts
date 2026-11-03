import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { canonicalizePath, isPathWithin } from "@harness/policy";
import type { HarnessDatabase, WorkspaceRecord } from "../storage/database";

export class WorkspaceRegistryError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

export interface WorkspaceView {
  createdAt: number;
  displayName: string;
  id: string;
  isAvailable: boolean;
  removedAt: number | null;
  rootPath: string;
  sortOrder: number;
  updatedAt: number;
}

export class WorkspaceRegistryService {
  public constructor(
    private readonly options: {
      database: HarnessDatabase;
      protectedPaths: readonly string[];
    },
  ) {}

  public async list(includeRemoved = false): Promise<WorkspaceView[]> {
    const records = this.options.database.listWorkspaces(includeRemoved);
    return Promise.all(records.map((record) => this.toView(record)));
  }

  public async add(rootPath: string, displayName?: string): Promise<WorkspaceView> {
    const canonical = await this.canonicalRoot(rootPath);
    this.assertNotProtected(canonical);
    const record = this.options.database.createWorkspace({
      ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
      rootPath: canonical,
    });
    return this.toView(record);
  }

  public async rename(id: string, displayName: string): Promise<WorkspaceView> {
    const name = displayName.trim();
    if (name === "" || name.length > 120) {
      throw new WorkspaceRegistryError("INVALID", "工作区名称必须为 1-120 个字符");
    }
    const record = this.options.database.updateWorkspaceName(id, name);
    if (record === null || record.removedAt !== null) {
      throw new WorkspaceRegistryError("NOT_FOUND", "工作区不存在");
    }
    return this.toView(record);
  }

  public async reorder(ids: readonly string[]): Promise<WorkspaceView[]> {
    try {
      const records = this.options.database.reorderWorkspaces(ids);
      return Promise.all(records.map((record) => this.toView(record)));
    } catch (error: unknown) {
      throw new WorkspaceRegistryError(
        "INVALID",
        error instanceof Error ? error.message : "工作区排序失败",
      );
    }
  }

  public remove(id: string): void {
    if (!this.options.database.softRemoveWorkspace(id)) {
      throw new WorkspaceRegistryError("NOT_FOUND", "工作区不存在或已移除");
    }
  }

  public requireRoot(id: string): string {
    const record = this.options.database.getWorkspace(id);
    if (record === null || record.removedAt !== null) {
      throw new WorkspaceRegistryError("NOT_FOUND", "工作区不存在或已移除");
    }
    return record.rootPath;
  }

  private async canonicalRoot(rootPath: string): Promise<string> {
    const trimmed = rootPath.trim();
    if (trimmed === "") throw new WorkspaceRegistryError("INVALID", "工作区路径不能为空");
    let canonical: string;
    try {
      canonical = await canonicalizePath(trimmed, false);
    } catch {
      throw new WorkspaceRegistryError("INVALID", "工作区目录不存在或无法访问");
    }
    const info = await stat(canonical).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new WorkspaceRegistryError("INVALID", "工作区必须是目录");
    }
    return canonical;
  }

  private assertNotProtected(rootPath: string): void {
    for (const protectedPath of this.options.protectedPaths) {
      if (isPathWithin(protectedPath, rootPath) || isPathWithin(rootPath, protectedPath)) {
        throw new WorkspaceRegistryError("INVALID", "工作区不能与 daemon 数据目录重叠");
      }
    }
  }

  private async toView(record: WorkspaceRecord): Promise<WorkspaceView> {
    const info = await stat(record.rootPath).catch(() => null);
    return {
      createdAt: record.createdAt,
      displayName: record.displayName || basename(record.rootPath) || record.rootPath,
      id: record.id,
      isAvailable: info?.isDirectory() === true && record.removedAt === null,
      removedAt: record.removedAt,
      rootPath: record.rootPath,
      sortOrder: record.sortOrder,
      updatedAt: record.updatedAt,
    };
  }
}
