import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ModelClient } from "@harness/core";
import { getDocumentProxy } from "unpdf";
import type { HarnessConfig } from "../config";
import { analyzeDocument } from "../literature/analyzer";
import { chunkDocument } from "../literature/chunker";
import { validateReportCitations } from "../literature/citations";
import type { HarnessDatabase, LiteratureRecord } from "../storage/database";

const MAX_PDF_BYTES = 30 * 1024 * 1024;

export type LiteratureErrorCode = "BUSY" | "INVALID" | "NOT_FOUND" | "UNSUPPORTED";

export class LiteratureServiceError extends Error {
  public constructor(
    public readonly code: LiteratureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LiteratureServiceError";
  }
}

export interface LiteratureLogger {
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface LiteratureServiceOptions {
  config: HarnessConfig;
  database: HarnessDatabase;
  logger: LiteratureLogger;
  modelClient: ModelClient;
}

export class LiteratureService {
  private readonly analyses = new Map<string, AbortController>();
  private readonly config: HarnessConfig;
  private readonly database: HarnessDatabase;
  private readonly logger: LiteratureLogger;
  private readonly modelClient: ModelClient;

  public constructor(options: LiteratureServiceOptions) {
    this.config = options.config;
    this.database = options.database;
    this.logger = options.logger;
    this.modelClient = options.modelClient;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.config.literatureDir, { recursive: true, mode: 0o700 });
    for (const record of this.database.listLiterature()) {
      if (record.status === "analyzing") {
        this.database.updateLiterature(record.id, {
          error: "daemon 重启导致分析中断，请重新解析",
          progress: null,
          stage: "failed",
          status: "failed",
        });
      }
      if (!this.database.hasKnowledgeDocument(`literature:${record.id}`)) {
        try {
          const pages = await this.readPages(record.id);
          this.indexLiterature(record, pages);
        } catch (error: unknown) {
          this.logger.warn({ err: error, literatureId: record.id }, "文献知识索引回填失败");
        }
      }
    }
  }

  public list(): LiteratureRecord[] {
    return this.database.listLiterature();
  }

  public get(id: string): LiteratureRecord {
    const record = this.database.getLiterature(id);
    if (record === null) throw new LiteratureServiceError("NOT_FOUND", "文献不存在");
    return record;
  }

  public async upload(input: { buffer: Buffer; fileName: string }): Promise<LiteratureRecord> {
    if (input.buffer.length === 0) throw new LiteratureServiceError("INVALID", "文件为空");
    if (input.buffer.length > MAX_PDF_BYTES) {
      throw new LiteratureServiceError("INVALID", "PDF 超过 30 MiB 限制");
    }
    if (input.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new LiteratureServiceError("UNSUPPORTED", "仅支持 PDF 文件");
    }

    const id = randomUUID();
    const directory = join(this.config.literatureDir, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fileName = sanitizeFileName(input.fileName);
    try {
      const pages = await extractPdfPages(input.buffer);
      const charCount = pages.reduce((total, page) => total + page.length, 0);
      await writeFile(join(directory, "source.pdf"), input.buffer, { mode: 0o600 });
      await writeFile(join(directory, "text.json"), JSON.stringify({ pages }), {
        encoding: "utf8",
        mode: 0o600,
      });
      const created = this.database.createLiterature({
        charCount,
        fileName,
        id,
        pageCount: pages.length,
        title: fileName.replace(/\.pdf$/iu, "").slice(0, 120) || "未命名文献",
      });
      try {
        this.indexLiterature(created, pages);
      } catch (error: unknown) {
        this.logger.warn({ err: error, literatureId: id }, "文献知识索引失败");
      }
      return created;
    } catch (error: unknown) {
      await rm(directory, { force: true, recursive: true });
      if (error instanceof LiteratureServiceError) throw error;
      throw new LiteratureServiceError(
        "INVALID",
        `PDF 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async getText(id: string): Promise<{ pages: string[]; pageCount: number }> {
    this.get(id);
    const pages = await this.readPages(id);
    return { pageCount: pages.length, pages };
  }

  public analyze(id: string): LiteratureRecord {
    const record = this.get(id);
    if (record.status === "analyzing") {
      throw new LiteratureServiceError("BUSY", "这篇文献正在解析中");
    }
    const controller = new AbortController();
    this.analyses.set(id, controller);
    this.database.updateLiterature(id, {
      chunkCount: null,
      error: null,
      progress: 0,
      reportJson: null,
      stage: "reading",
      status: "analyzing",
    });
    void this.runAnalysis(id, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.logger.error({ err: error, literatureId: id }, "文献解析失败");
      try {
        this.database.updateLiterature(id, {
          error: error instanceof Error ? error.message.slice(0, 500) : "解析失败",
          progress: null,
          stage: "failed",
          status: "failed",
        });
      } catch (updateError: unknown) {
        this.logger.error({ err: updateError, literatureId: id }, "文献失败状态写入失败");
      }
    });
    return this.get(id);
  }

  public cancel(id: string): LiteratureRecord {
    this.get(id);
    this.analyses.get(id)?.abort();
    this.analyses.delete(id);
    this.database.updateLiterature(id, {
      error: "分析已取消",
      progress: null,
      stage: "cancelled",
      status: "ready",
    });
    return this.get(id);
  }

  public async delete(id: string): Promise<void> {
    this.get(id);
    this.analyses.get(id)?.abort();
    this.analyses.delete(id);
    await rm(join(this.config.literatureDir, id), { force: true, recursive: true });
    this.database.deleteKnowledgeDocument(`literature:${id}`);
    this.database.deleteLiterature(id);
  }

  private async runAnalysis(id: string, signal: AbortSignal): Promise<void> {
    const record = this.get(id);
    const pages = await this.readPages(id);
    if (signal.aborted) return;
    const chunked = chunkDocument(pages);
    this.updateProgress(id, "analyzing", 10, chunked.chunks.length, signal);

    const report = await analyzeDocument({
      chunked,
      maxTokens: Math.min(this.config.maxTokens, 16_000),
      model: this.config.model,
      modelClient: this.modelClient,
      onProgress: (stage, progress) => {
        if (!signal.aborted) {
          this.updateProgress(id, stage, progress, chunked.chunks.length, signal);
        }
      },
      onWarning: (message, details) => this.logger.warn({ literatureId: id, ...details }, message),
      pages,
      signal,
    });
    if (signal.aborted) return;
    this.updateProgress(id, "validating", 90, chunked.chunks.length, signal);
    const validated = validateReportCitations(report, pages);
    if (signal.aborted) return;
    const title = validated.report.title.trim() || record.title;
    this.database.updateLiterature(id, {
      error: null,
      progress: 100,
      reportJson: JSON.stringify(validated.report),
      stage: "done",
      status: "done",
      title,
    });
    try {
      this.database.updateKnowledgeDocumentTitle(`literature:${id}`, title);
    } catch (error: unknown) {
      this.logger.warn({ err: error, literatureId: id }, "文献知识标题更新失败");
    }
  }

  private indexLiterature(record: LiteratureRecord, pages: readonly string[]): void {
    const indexed = chunkDocument(pages, {
      maxChunks: 200,
      singlePassLimit: 0,
      targetChars: 12_000,
    });
    this.database.indexKnowledgeDocument(
      {
        id: `literature:${record.id}`,
        kind: "literature",
        sourceId: record.id,
        title: record.title,
      },
      indexed.chunks.map((chunk) => ({
        content: chunk.text,
        id: `knowledge:${record.id}:${chunk.index}`,
        ordinal: chunk.index,
        pageEnd: chunk.pageEnd,
        pageStart: chunk.pageStart,
        section: chunk.section,
      })),
    );
  }

  private updateProgress(
    id: string,
    stage: string,
    progress: number,
    chunkCount: number,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    try {
      this.database.updateLiterature(id, { progress, stage });
      const current = this.database.getLiterature(id);
      if (current !== null && current.chunkCount !== chunkCount) {
        this.database.updateLiterature(id, { chunkCount });
      }
    } catch (error: unknown) {
      this.logger.warn({ err: error, literatureId: id }, "文献进度写入失败");
    }
  }

  private async readPages(id: string): Promise<string[]> {
    const path = join(this.config.literatureDir, id, "text.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new LiteratureServiceError("NOT_FOUND", "文献正文不存在");
      }
      throw new LiteratureServiceError("INVALID", "文献正文已损坏");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pages" in parsed) ||
      !Array.isArray(parsed.pages) ||
      !parsed.pages.every((page: unknown) => typeof page === "string")
    ) {
      throw new LiteratureServiceError("INVALID", "文献正文格式无效");
    }
    return parsed.pages as string[];
  }
}

export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items as unknown as Array<{
      hasEOL?: boolean;
      str?: unknown;
      transform?: number[];
    }>;
    let text = "";
    let previousY: number | null = null;
    for (const item of items) {
      if (typeof item.str !== "string" || item.str === "") continue;
      const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
      if (previousY !== null && typeof y === "number" && Math.abs(y - previousY) > 2) {
        text += "\n";
      }
      text += item.str;
      text += item.hasEOL === true ? "\n" : " ";
      if (typeof y === "number") previousY = y;
    }
    pages.push(
      text
        .replace(/[ \t]+/gu, " ")
        .replace(/ *\n */gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .trim(),
    );
  }
  return pages;
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[\\/:*?"<>|\0]/gu, "_")
    .trim();
  return (name || "document.pdf").slice(0, 200);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
