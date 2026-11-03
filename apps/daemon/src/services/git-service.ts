import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GitServiceError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_REPO",
    message: string,
  ) {
    super(message);
    this.name = "GitServiceError";
  }
}

export interface GitFileStatus {
  index: string;
  path: string;
  staged: boolean;
  worktree: string;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  files: GitFileStatus[];
}

export class GitService {
  public async status(workspaceRoot: string): Promise<GitStatus> {
    const output = await this.git(workspaceRoot, ["status", "--porcelain=v1", "--branch"]);
    const lines = output.split(/\r?\n/u).filter((line) => line !== "");
    let branch = "HEAD";
    const files: GitFileStatus[] = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        branch = line.slice(3).split("...")[0]?.trim() || "HEAD";
        continue;
      }
      const index = line[0] ?? " ";
      const worktree = line[1] ?? " ";
      const path = line.slice(3).trim();
      if (path === "") continue;
      files.push({
        index,
        path,
        staged: index !== " " && index !== "?",
        worktree,
      });
    }
    return { branch, clean: files.length === 0, files };
  }

  public async diff(workspaceRoot: string, path?: string, staged = false): Promise<string> {
    const args = ["diff", "--no-ext-diff"];
    if (staged) args.push("--cached");
    if (path !== undefined) {
      this.validatePath(path);
      args.push("--", path);
    }
    return this.git(workspaceRoot, args);
  }

  public async stage(workspaceRoot: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new GitServiceError("INVALID", "没有要暂存的文件");
    for (const path of paths) this.validatePath(path);
    await this.git(workspaceRoot, ["add", "--", ...paths]);
  }

  public async unstage(workspaceRoot: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) throw new GitServiceError("INVALID", "没有要取消暂存的文件");
    for (const path of paths) this.validatePath(path);
    await this.git(workspaceRoot, ["reset", "--", ...paths]);
  }

  public async commit(workspaceRoot: string, message: string): Promise<string> {
    const trimmed = message.trim();
    if (trimmed === "" || trimmed.length > 500) {
      throw new GitServiceError("INVALID", "提交信息必须为 1-500 个字符");
    }
    return this.git(workspaceRoot, ["commit", "-m", trimmed]);
  }

  private async git(workspaceRoot: string, args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run("git", args, {
        cwd: workspaceRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout;
    } catch (error: unknown) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      const message = stderr.trim() || (error instanceof Error ? error.message : "git 执行失败");
      if (!(await this.isRepo(workspaceRoot))) {
        throw new GitServiceError("NOT_REPO", "当前工作区不是 Git 仓库");
      }
      throw new GitServiceError("INVALID", message.slice(0, 2_000));
    }
  }

  private async isRepo(workspaceRoot: string): Promise<boolean> {
    try {
      const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspaceRoot,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 5_000,
        windowsHide: true,
      });
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private validatePath(path: string): void {
    if (path.trim() === "" || path.startsWith("/") || path.split(/[\\/]/u).includes("..")) {
      throw new GitServiceError("INVALID", "Git 路径必须是 workspace 内相对路径");
    }
  }
}
