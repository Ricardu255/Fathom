import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isPathWithin } from "@harness/policy";
import { readSkillFile, SkillError } from "./skill-registry";

const run = promisify(execFile);
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 4;
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,120}$/u;

export interface InstallSkillInput {
  ref?: string | undefined;
  repo: string;
  subdir?: string | undefined;
}

export interface InstalledSkill {
  bytes: number;
  files: number;
  name: string;
  targetDir: string;
}

/** 从 GitHub 安装 Skill 到全局目录；只接受 owner/repo，不接受任意 URL 或本地路径。 */
export async function installSkillFromGithub(
  input: InstallSkillInput,
  targetRoot: string,
): Promise<InstalledSkill> {
  const repo = input.repo.trim();
  if (!REPO_PATTERN.test(repo) || repo.includes("..")) {
    throw new SkillError("INVALID", "repo 必须是 owner/repo 形式");
  }
  const ref = input.ref?.trim();
  if (ref !== undefined && ref !== "" && (!REF_PATTERN.test(ref) || ref.includes(".."))) {
    throw new SkillError("INVALID", "ref 无效");
  }
  const subdir = input.subdir?.trim();
  if (
    subdir !== undefined &&
    subdir !== "" &&
    (subdir.startsWith("/") || subdir.split(/[\\/]/u).some((part) => part === ".."))
  ) {
    throw new SkillError("INVALID", "subdir 无效");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "fathom-skill-install-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (ref !== undefined && ref !== "") args.push("--branch", ref);
    args.push(`https://github.com/${repo}.git`, tempRoot);
    await run("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
    const source = await locateSkillDirectory(tempRoot, subdir);
    const parsed = await readSkillFile(join(source, "SKILL.md"));
    const targetDir = join(targetRoot, parsed.name);
    try {
      await stat(targetDir);
      throw new SkillError("CONFLICT", `Skill ${parsed.name} 已存在`);
    } catch (error: unknown) {
      if (error instanceof SkillError) throw error;
      if (!isEnoent(error)) throw error;
    }
    const staging = join(targetRoot, `.install-${parsed.name}-${Date.now()}`);
    await rm(staging, { force: true, recursive: true });
    await mkdir(staging, { recursive: true });
    try {
      const copied = await copySkillDirectory(source, staging);
      await mkdir(targetRoot, { recursive: true });
      await rename(staging, targetDir);
      return { ...copied, name: parsed.name, targetDir };
    } catch (error: unknown) {
      await rm(staging, { force: true, recursive: true });
      throw error;
    }
  } finally {
    await rm(tempRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

export async function copySkillDirectory(
  source: string,
  target: string,
): Promise<{ bytes: number; files: number }> {
  const totals = { bytes: 0, files: 0 };
  const copy = async (current: string, destination: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new SkillError("TOO_LARGE", "Skill 目录层级过深");
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const from = join(current, entry.name);
      const to = join(destination, entry.name);
      const info = await lstat(from);
      if (info.isSymbolicLink()) {
        throw new SkillError("INVALID", "拒绝安装包含符号链接的 Skill");
      }
      if (info.isDirectory()) {
        await copy(from, to, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      totals.files += 1;
      totals.bytes += info.size;
      if (totals.files > MAX_FILES) throw new SkillError("TOO_LARGE", "Skill 文件数超过 200");
      if (totals.bytes > MAX_BYTES) throw new SkillError("TOO_LARGE", "Skill 超过 5MB");
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  };
  await copy(source, target, 0);
  return totals;
}

async function locateSkillDirectory(repoRoot: string, subdir?: string): Promise<string> {
  if (subdir !== undefined && subdir !== "") {
    const candidate = resolve(repoRoot, subdir);
    if (!isPathWithin(resolve(repoRoot), candidate)) {
      throw new SkillError("INVALID", "subdir 越出仓库目录");
    }
    await readSkillFile(join(candidate, "SKILL.md"));
    return candidate;
  }
  try {
    await readSkillFile(join(repoRoot, "SKILL.md"));
    return repoRoot;
  } catch {
    // 继续向下查找。
  }
  const found: string[] = [];
  const search = async (current: string, depth: number): Promise<void> => {
    if (depth > 3 || found.length > 1) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      const directory = join(current, entry.name);
      try {
        await readSkillFile(join(directory, "SKILL.md"));
        found.push(directory);
      } catch {
        await search(directory, depth + 1);
      }
    }
  };
  await search(repoRoot, 0);
  if (found.length === 0) throw new SkillError("NOT_FOUND", "仓库中没有找到 SKILL.md");
  if (found.length > 1) {
    throw new SkillError("INVALID", "仓库包含多个 Skill，请指定 subdir");
  }
  const [first] = found;
  if (first === undefined) throw new SkillError("NOT_FOUND", "仓库中没有找到 SKILL.md");
  return first;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
