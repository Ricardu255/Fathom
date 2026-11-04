import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPathWithin } from "@harness/policy";

export type SkillScope = "global" | "project" | "system";

export interface SkillSummary {
  /** 规范里的 allowed-tools：声明式预授权清单，运行时仍要过审批。 */
  allowedTools?: readonly string[];
  /** 环境要求，例如需要某个 CLI 或系统权限。 */
  compatibility?: string;
  description: string;
  directory: string;
  enabled: boolean;
  id: string;
  /** 许可证名称或随附的许可证文件。 */
  license?: string;
  name: string;
  scope: SkillScope;
  skillFile: string;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  resources: Array<{ path: string; size: number }>;
}

export interface SkillRegistryOptions {
  disabled?: readonly string[];
  globalDir: string;
  systemDir: string;
  workspaceRoot?: string | undefined;
}

export class SkillError extends Error {
  public constructor(
    public readonly code: "CONFLICT" | "DISABLED" | "INVALID" | "NOT_FOUND" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_BODY_CHARS = 200_000;
const MAX_RESOURCE_BYTES = 512 * 1024;
const MAX_RESOURCES = 100;
const MAX_CATALOG_SKILLS = 40;
const MAX_CATALOG_CHARS = 6_000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SCOPE_PRIORITY: Record<SkillScope, number> = { system: 0, global: 1, project: 2 };

/** 每个 workspace 独立的 Skill 注册表；扫描 system/global/project 并处理同名覆盖。 */
export class SkillRegistry {
  private readonly disabled: Set<string>;

  public constructor(private readonly options: SkillRegistryOptions) {
    this.disabled = new Set(options.disabled ?? []);
  }

  public async list(options: { includeDisabled?: boolean } = {}): Promise<SkillSummary[]> {
    const all = await this.scan();
    const selected = resolveSkills(all);
    return options.includeDisabled === true ? selected : selected.filter((skill) => skill.enabled);
  }

  public async detail(scope: SkillScope, id: string): Promise<SkillDetail> {
    const skills = await this.list({ includeDisabled: true });
    const skill = skills.find((item) => item.scope === scope && item.id === id);
    if (skill === undefined) throw new SkillError("NOT_FOUND", "Skill 不存在");
    const content = await readSkillFile(skill.skillFile);
    const resources = await listResources(skill.directory);
    return { ...skill, body: content.body, resources };
  }

  public async load(name: string, resource?: string): Promise<string> {
    const skill = await this.requireEnabled(name);
    if (resource === undefined || resource.trim() === "") {
      return (await readSkillFile(skill.skillFile)).body;
    }
    return readResource(skill.directory, resource);
  }

  public async catalogText(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "";
    const lines = skills
      .slice(0, MAX_CATALOG_SKILLS)
      .map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/gu, " ").slice(0, 240)}`);
    const text = [
      "可用 Skills（需要时先用 load_skill 读取正文，不要假设正文已加载）：",
      ...lines,
    ].join("\n");
    return text.length > MAX_CATALOG_CHARS ? `${text.slice(0, MAX_CATALOG_CHARS)}…` : text;
  }

  /** 从用户消息中解析 `$skill-name` 引用，返回启用且存在的 Skill。 */
  public async resolveRefs(text: string): Promise<SkillSummary[]> {
    const ids = new Set<string>();
    for (const match of text.matchAll(/(?:^|\s)\$([a-z0-9][a-z0-9-]{0,63})/giu)) {
      const id = match[1];
      if (id !== undefined) ids.add(id.toLowerCase());
    }
    if (ids.size === 0) return [];
    const skills = await this.list();
    return skills.filter((skill) => ids.has(skill.id) || ids.has(skill.name));
  }

  public async createProjectSkill(input: {
    body: string;
    description: string;
    name: string;
  }): Promise<SkillSummary> {
    if (this.options.workspaceRoot === undefined) {
      throw new SkillError("INVALID", "当前 Session 没有 workspace，无法创建项目 Skill");
    }
    const name = input.name.trim().toLowerCase();
    const description = input.description.trim().replace(/\s+/gu, " ");
    const body = input.body.trim();
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new SkillError("INVALID", "name 只能包含小写字母、数字和连字符，最长 64");
    }
    if (description === "" || description.length > 2_000) {
      throw new SkillError("INVALID", "description 长度必须在 1-2000 字符之间");
    }
    if (body === "" || body.length > MAX_SKILL_BODY_CHARS) {
      throw new SkillError("INVALID", "body 长度必须在 1-200000 字符之间");
    }
    const directory = join(this.options.workspaceRoot, ".fathom", "skills", name);
    try {
      await stat(join(directory, "SKILL.md"));
      throw new SkillError("CONFLICT", `Skill ${name} 已存在`);
    } catch (error: unknown) {
      if (error instanceof SkillError) throw error;
      if (!isEnoent(error)) throw error;
    }
    await mkdir(directory, { recursive: true });
    const skillFile = join(directory, "SKILL.md");
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
    await writeAtomically(skillFile, content);
    return {
      description,
      directory,
      enabled: true,
      id: name,
      name,
      scope: "project",
      skillFile,
    };
  }

  private async requireEnabled(name: string): Promise<SkillSummary> {
    const skills = await this.list();
    const skill = skills.find((item) => item.id === name || item.name === name);
    if (skill === undefined) throw new SkillError("NOT_FOUND", `Skill 不存在或已禁用：${name}`);
    return skill;
  }

  private async scan(): Promise<SkillSummary[]> {
    const found: SkillSummary[] = [];
    const directories: Array<{ dir: string; scope: SkillScope }> = [
      { dir: this.options.systemDir, scope: "system" },
      { dir: this.options.globalDir, scope: "global" },
    ];
    if (this.options.workspaceRoot !== undefined) {
      directories.push(
        { dir: join(this.options.workspaceRoot, ".fathom", "skills"), scope: "project" },
        { dir: join(this.options.workspaceRoot, ".agents", "skills"), scope: "project" },
      );
    }
    for (const { dir, scope } of directories) {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = join(dir, entry.name);
        const skillFile = join(directory, "SKILL.md");
        try {
          const content = await readSkillFile(skillFile);
          const id = content.name;
          found.push({
            ...(content.allowedTools === undefined ? {} : { allowedTools: content.allowedTools }),
            ...(content.compatibility === undefined
              ? {}
              : { compatibility: content.compatibility }),
            description: content.description,
            directory,
            enabled: !this.disabled.has(`${scope}:${id}`),
            id,
            ...(content.license === undefined ? {} : { license: content.license }),
            name: content.name,
            scope,
            skillFile,
          });
        } catch {
          // 无效 Skill 不影响其他 Skill。
        }
      }
    }
    return found;
  }
}

export interface SkillFrontmatter {
  allowedTools?: readonly string[];
  body: string;
  compatibility?: string;
  description: string;
  license?: string;
  name: string;
}

export async function readSkillFile(skillFile: string): Promise<SkillFrontmatter> {
  const info = await stat(skillFile);
  if (!info.isFile()) throw new SkillError("INVALID", "SKILL.md 不是文件");
  if (info.size > MAX_SKILL_FILE_BYTES) throw new SkillError("TOO_LARGE", "SKILL.md 超过 256KB");
  const content = await readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(content);
  if (parsed === null) throw new SkillError("INVALID", "SKILL.md frontmatter 无效");
  return parsed;
}

export function parseSkillMarkdown(content: string): SkillFrontmatter | null {
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  const meta = parseFrontmatter(lines.slice(1, end));
  const name = meta.get("name")?.trim().toLowerCase();
  const description = meta.get("description")?.trim();
  if (name === undefined || !SKILL_NAME_PATTERN.test(name)) return null;
  if (description === undefined || description === "" || description.length > 2_000) return null;
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  if (body === "" || body.length > MAX_SKILL_BODY_CHARS) return null;
  const compatibility = nonEmpty(meta.get("compatibility"));
  const license = nonEmpty(meta.get("license"));
  const allowedTools = parseAllowedTools(meta.get("allowed-tools"));
  return {
    ...(allowedTools === undefined ? {} : { allowedTools }),
    body,
    ...(compatibility === undefined ? {} : { compatibility }),
    description,
    ...(license === undefined ? {} : { license }),
    name,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** `allowed-tools` 允许三种写法：YAML 列表、`[a, b]` 流式写法、逗号分隔。 */
export function parseAllowedTools(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .replace(/^\s*\[|\]\s*$/gu, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/gu, ""))
    .filter((item) => item !== "");
  return items.length === 0 ? undefined : items;
}

function parseFrontmatter(lines: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (key === undefined) continue;
    const value = match[2] ?? "";
    if (value === "") {
      // YAML 列表：`allowed-tools:` 后面跟若干 `- 工具名` 行。
      const items: string[] = [];
      let lookahead = index + 1;
      while (lookahead < lines.length) {
        const next = lines[lookahead];
        const bullet = next === undefined ? null : /^\s*-\s+(.*)$/u.exec(next);
        if (bullet === null) break;
        const item = bullet[1]?.trim();
        if (item !== undefined && item !== "") items.push(item);
        lookahead += 1;
      }
      if (items.length > 0) {
        result.set(key, items.join(", "));
        index = lookahead - 1;
        continue;
      }
    }
    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      const block: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index];
        if (next === undefined || !/^\s+/u.test(next)) {
          index -= 1;
          break;
        }
        block.push(next.trim());
      }
      result.set(key, value.startsWith("|") ? block.join("\n") : block.join(" "));
      continue;
    }
    result.set(key, value.replace(/^["']|["']$/gu, ""));
  }
  return result;
}

function resolveSkills(skills: readonly SkillSummary[]): SkillSummary[] {
  const byId = new Map<string, SkillSummary>();
  for (const skill of skills) {
    const current = byId.get(skill.id);
    if (current === undefined || SCOPE_PRIORITY[skill.scope] > SCOPE_PRIORITY[current.scope]) {
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function listResources(directory: string): Promise<Array<{ path: string; size: number }>> {
  const resources: Array<{ path: string; size: number }> = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    if (resources.length >= MAX_RESOURCES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (resources.length >= MAX_RESOURCES) return;
      if (entry.name === "SKILL.md" && prefix === "") continue;
      const absolute = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        resources.push({ path: relativePath, size: info.size });
      }
    }
  };
  await walk(directory, "");
  return resources;
}

async function readResource(directory: string, resource: string): Promise<string> {
  const normalized = resource.replace(/\\/gu, "/").trim();
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new SkillError("INVALID", "资源路径无效");
  }
  const target = resolve(directory, normalized);
  const canonicalDirectory = await realpath(directory);
  const canonicalTarget = await realpath(target);
  if (!isPathWithin(canonicalDirectory, canonicalTarget)) {
    throw new SkillError("INVALID", "拒绝访问 Skill 目录外部资源");
  }
  const info = await stat(canonicalTarget);
  if (!info.isFile()) throw new SkillError("INVALID", "资源不是文件");
  if (info.size > MAX_RESOURCE_BYTES) throw new SkillError("TOO_LARGE", "资源超过 512KB");
  const buffer = await readFile(canonicalTarget);
  if (buffer.includes(0)) throw new SkillError("INVALID", "二进制资源不能作为文本加载");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
