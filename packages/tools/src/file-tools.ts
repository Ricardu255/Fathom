import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FileChange, Tool, ToolAnnotations, ToolContext, ToolResult } from "@harness/core";
import { PathPolicyError, resolveWorkspacePath } from "@harness/policy";
import { createPatch } from "diff";
import { z } from "zod";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_BYTES = 512 * 1024;
const IGNORED_DIRECTORIES = new Set([".git", ".harness", "coverage", "dist", "node_modules"]);

interface ToolConfig<T extends z.ZodType> {
  annotations?: ToolAnnotations;
  description: string;
  execute: (input: z.output<T>, context: ToolContext) => Promise<ToolResult>;
  inputSchema: T;
  name: string;
  requiresApproval: boolean;
  summarize: (input: z.output<T>) => string;
}

function defineTool<T extends z.ZodType>(config: ToolConfig<T>): Tool {
  return {
    ...(config.annotations === undefined ? {} : { annotations: config.annotations }),
    description: config.description,
    execute: (input, context) =>
      config.execute(config.inputSchema.parse(input) as z.output<T>, context),
    inputSchema: toJsonSchema(config.inputSchema),
    name: config.name,
    parse: (input) => config.inputSchema.parse(input),
    requiresApproval: config.requiresApproval,
    summarize: (input) => config.summarize(config.inputSchema.parse(input) as z.output<T>),
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function resolve(context: ToolContext, path: string, allowMissing = false): Promise<string> {
  return resolveWorkspacePath({
    ...(allowMissing ? { allowMissing: true } : {}),
    ...(context.protectedPaths === undefined ? {} : { protectedPaths: context.protectedPaths }),
    path,
    workspaceRoot: context.workspaceRoot,
  });
}

function relativeDisplay(workspaceRoot: string, absolutePath: string): string {
  const value = relative(workspaceRoot, absolutePath);
  return value.split("\\").join("/");
}

async function readTextFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("目标不是普通文件");
  if (metadata.size > MAX_TEXT_BYTES) {
    throw new Error(`文件超过 ${MAX_TEXT_BYTES} 字节限制`);
  }
  const buffer = await readFile(path);
  if (buffer.includes(0)) throw new Error("二进制文件不能作为文本读取");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本");
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_TEXT_BYTES) return null;
    const buffer = await readFile(path);
    if (buffer.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function buildFileChange(path: string, before: string | null, after: string): FileChange {
  const diff = createPatch(path, before ?? "", after, "before", "after");
  return {
    after,
    before,
    diff: clipDiff(diff, 60_000),
    path,
  };
}

function clipDiff(diff: string, maximum: number): string {
  return diff.length > maximum
    ? `${diff.slice(0, maximum)}
[diff 已截断]`
    : diff;
}

async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const listFilesSchema = z.object({
  depth: z.number().int().min(1).max(8).optional().describe("递归深度，默认 3"),
  path: z.string().min(1).optional().describe("相对 workspace 的目录，默认根目录"),
});

export interface WorkspaceEntry {
  path: string;
  type: "directory" | "file";
}

/** 与 list_files 共用同一套忽略规则，供 @ 文件引用等 UI 使用。 */
export async function listWorkspaceEntries(input: {
  depth?: number | undefined;
  maxEntries?: number | undefined;
  path?: string | undefined;
  protectedPaths?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
  workspaceRoot: string;
}): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const root = await resolveWorkspacePath({
    ...(input.protectedPaths === undefined ? {} : { protectedPaths: input.protectedPaths }),
    path: input.path ?? ".",
    workspaceRoot: input.workspaceRoot,
  });
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error("path 必须是目录");
  const maxEntries = Math.min(Math.max(input.maxEntries ?? MAX_LIST_ENTRIES, 1), 2_000);
  const maxDepth = input.depth ?? 3;
  const entries: WorkspaceEntry[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (entries.length >= maxEntries || input.signal?.aborted) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= maxEntries || input.signal?.aborted) return;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
      const absolutePath = join(directory, child.name);
      try {
        await resolveWorkspacePath({
          ...(input.protectedPaths === undefined ? {} : { protectedPaths: input.protectedPaths }),
          path: absolutePath,
          workspaceRoot: input.workspaceRoot,
        });
      } catch (error: unknown) {
        if (error instanceof PathPolicyError) continue;
        throw error;
      }
      const displayPath = relativeDisplay(input.workspaceRoot, absolutePath);
      if (child.isDirectory()) {
        entries.push({ path: displayPath, type: "directory" });
        if (depth > 1) await walk(absolutePath, depth - 1);
      } else if (child.isFile()) {
        entries.push({ path: displayPath, type: "file" });
      }
    }
  };

  await walk(root, maxDepth);
  return { entries, truncated: entries.length >= maxEntries };
}

export const listFilesTool = defineTool({
  description:
    "列出 workspace 内的文件和目录。会忽略 .git、node_modules、dist 等目录，结果最多 500 项。",
  execute: async (input, context) => {
    const result = await listWorkspaceEntries({
      ...(input.depth === undefined ? {} : { depth: input.depth }),
      ...(input.path === undefined ? {} : { path: input.path }),
      protectedPaths: context.protectedPaths,
      signal: context.signal,
      workspaceRoot: context.workspaceRoot,
    });
    const entries = result.entries.map((entry) =>
      entry.type === "directory" ? `${entry.path}/` : entry.path,
    );
    return {
      content: entries.length
        ? `${entries.join("\n")}${result.truncated ? "\n\n[结果已截断]" : ""}`
        : "(empty)",
    };
  },
  inputSchema: listFilesSchema,
  name: "list_files",
  requiresApproval: false,
  summarize: (input) => `列出 ${input.path ?? "."}`,
});

const readFileSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional().describe("最多读取多少行，默认全部"),
  offset: z.number().int().min(1).optional().describe("从第几行开始（1-based）"),
  path: z.string().min(1).describe("相对 workspace 的文件路径"),
});

export const readFileTool = defineTool({
  description: "读取 workspace 内的 UTF-8 文本文件，可按行分页。文件上限 1 MiB。",
  execute: async (input, context) => {
    const absolutePath = await resolve(context, input.path);
    const content = await readTextFile(absolutePath);
    const lines = content.split(/\r?\n/u);
    const offset = (input.offset ?? 1) - 1;
    const limit = input.limit ?? lines.length;
    const selected = lines.slice(offset, offset + limit);
    const end = offset + selected.length;
    const header = `文件: ${relativeDisplay(context.workspaceRoot, absolutePath)} (${lines.length} 行)\n`;
    const range = `\n[显示第 ${offset + 1}-${end} 行]`;
    return {
      content: `${header}${selected.map((line, index) => `${offset + index + 1}| ${line}`).join("\n")}${
        end < lines.length ? range : ""
      }`,
      observedFiles: [{ hash: hashText(content), path: absolutePath }],
    };
  },
  inputSchema: readFileSchema,
  name: "read_file",
  annotations: { idempotent: true, readOnly: true },
  requiresApproval: false,
  summarize: (input) => `读取 ${input.path}`,
});

const writeFileSchema = z.object({
  content: z.string().max(MAX_TEXT_BYTES).describe("完整文件内容"),
  path: z.string().min(1).describe("相对 workspace 的文件路径"),
});

export const writeFileTool = defineTool({
  description: "创建或完整覆盖 workspace 内的文本文件（UTF-8，最大 1 MiB）。需要用户审批。",
  execute: async (input, context) => {
    const absolutePath = await resolve(context, input.path, true);
    const displayPath = relativeDisplay(context.workspaceRoot, absolutePath);
    const before = await readOptionalText(absolutePath);
    await writeTextFileAtomic(absolutePath, input.content);
    const change = buildFileChange(displayPath, before, input.content);
    return {
      content: `已写入 ${displayPath}（${Buffer.byteLength(input.content, "utf8")} 字节）

${clipDiff(change.diff, 12_000)}`,
      fileChanges: [change],
      observedFiles: [{ hash: hashText(input.content), path: absolutePath }],
    };
  },
  inputSchema: writeFileSchema,
  name: "write_file",
  annotations: { destructive: true },
  requiresApproval: true,
  summarize: (input) => `写入 ${input.path}（${Buffer.byteLength(input.content, "utf8")} 字节）`,
});

const editFileSchema = z.object({
  newText: z.string().max(MAX_TEXT_BYTES),
  oldText: z.string().min(1).max(MAX_TEXT_BYTES),
  path: z.string().min(1),
});

export const editFileTool = defineTool({
  description: "把 workspace 文件中的一段唯一文本替换为另一段文本。需要用户审批。",
  execute: async (input, context) => {
    const absolutePath = await resolve(context, input.path);
    const before = await readTextFile(absolutePath);
    const matchIndex = before.indexOf(input.oldText);
    if (matchIndex === -1) throw new Error("oldText 在文件中不存在");
    if (before.indexOf(input.oldText, matchIndex + input.oldText.length) !== -1) {
      throw new Error("oldText 在文件中不唯一，请提供更多上下文");
    }
    const after = `${before.slice(0, matchIndex)}${input.newText}${before.slice(
      matchIndex + input.oldText.length,
    )}`;
    if (Buffer.byteLength(after, "utf8") > MAX_TEXT_BYTES) throw new Error("修改后文件超过 1 MiB");
    await writeTextFileAtomic(absolutePath, after);
    const displayPath = relativeDisplay(context.workspaceRoot, absolutePath);
    const change = buildFileChange(displayPath, before, after);
    return {
      content: `已更新 ${displayPath}

${clipDiff(change.diff, 12_000)}`,
      fileChanges: [change],
      observedFiles: [{ hash: hashText(after), path: absolutePath }],
    };
  },
  inputSchema: editFileSchema,
  name: "edit_file",
  requiresApproval: true,
  summarize: (input) => `编辑 ${input.path}`,
});

const searchTextSchema = z.object({
  context: z.number().int().min(0).max(3).optional().describe("每处匹配附带的上下文行数"),
  maxResults: z.number().int().min(1).max(200).optional(),
  path: z.string().min(1).optional(),
  query: z.string().min(1).max(500).describe("JavaScript 正则表达式"),
});

export const searchTextTool = defineTool({
  description:
    "在 workspace 文本文件中按正则搜索，返回 file:line 形式的匹配和可选上下文。最多 200 条结果。",
  execute: async (input, context) => {
    const start = await resolve(context, input.path ?? ".");
    const metadata = await stat(start);
    const matcher = compileMatcher(input.query);
    const maxResults = input.maxResults ?? 50;
    const contextLines = input.context ?? 0;
    const matches: string[] = [];
    let filesVisited = 0;

    const searchFile = async (absolutePath: string): Promise<void> => {
      if (matches.length >= maxResults || context.signal.aborted) return;
      if (filesVisited >= MAX_SEARCH_FILES) return;
      filesVisited += 1;
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_BYTES) return;
      let content: string;
      try {
        content = await readTextFile(absolutePath);
      } catch {
        return;
      }
      const lines = content.split(/\r?\n/u);
      const displayPath = relativeDisplay(context.workspaceRoot, absolutePath);
      for (let index = 0; index < lines.length; index += 1) {
        matcher.lastIndex = 0;
        if (!matcher.test(lines[index] ?? "")) continue;
        const from = Math.max(0, index - contextLines);
        const to = Math.min(lines.length, index + contextLines + 1);
        for (let cursor = from; cursor < to; cursor += 1) {
          const marker = cursor === index ? ":" : "-";
          matches.push(`${displayPath}:${cursor + 1}${marker} ${lines[cursor] ?? ""}`);
        }
        if (matches.length >= maxResults) return;
      }
    };

    const walk = async (directory: string): Promise<void> => {
      if (matches.length >= maxResults || context.signal.aborted) return;
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        if (matches.length >= maxResults || context.signal.aborted) return;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && IGNORED_DIRECTORIES.has(child.name)) continue;
        const absolutePath = join(directory, child.name);
        try {
          await resolve(context, absolutePath);
        } catch (error: unknown) {
          if (error instanceof PathPolicyError) continue;
          throw error;
        }
        if (child.isDirectory()) await walk(absolutePath);
        else if (child.isFile()) await searchFile(absolutePath);
      }
    };

    if (metadata.isFile()) await searchFile(start);
    else await walk(start);

    if (matches.length === 0) return { content: "(no matches)" };
    return {
      content: `${matches.join("\n")}${matches.length >= maxResults ? "\n\n[结果已截断]" : ""}`,
    };
  },
  inputSchema: searchTextSchema,
  name: "search_text",
  requiresApproval: false,
  summarize: (input) => `搜索 /${input.query}/`,
});

function compileMatcher(query: string): RegExp {
  try {
    return new RegExp(query, "iu");
  } catch {
    throw new Error("query 不是有效的正则表达式");
  }
}
