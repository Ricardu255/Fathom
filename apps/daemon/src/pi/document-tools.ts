import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { resolveWorkspacePath } from "@harness/policy";
import { inspectPages, renderPageAsImage } from "unpdf";
import { z } from "zod";
import { extractDocumentBuffer } from "../services/attachment-service";

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 200_000;
const MAX_RENDERED_BYTES = 8 * 1024 * 1024;

const readDocumentSchema = z.object({
  maxChars: z.number().int().min(1_000).max(MAX_DOCUMENT_CHARS).default(60_000),
  path: z.string().min(1).max(1_024).describe("workspace 内的 PDF/DOCX/PPTX/XLSX/文本文档"),
});

const viewPdfPageSchema = z.object({
  page: z.number().int().min(1).max(10_000),
  path: z.string().min(1).max(1_024),
  scale: z.number().min(0.5).max(2).default(1.5),
});

export interface DocumentToolOptions {
  supportsImages: () => boolean;
}

export function createReadDocumentTool(): Tool {
  return {
    description:
      "读取 workspace 内的 PDF、DOCX、PPTX、XLSX、纯文本或 Markdown 文档，返回有界文本。PDF 按页提取，PPTX 按幻灯片标注；单文件上限 15MB。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = readDocumentSchema.parse(input);
      context.signal.throwIfAborted();
      const absolute = await resolvePath(context, parsed.path);
      const info = await stat(absolute);
      if (!info.isFile()) return { content: "目标不是文件。", isError: true };
      if (info.size > MAX_DOCUMENT_BYTES) {
        return { content: "文档超过 15MB 限制。", isError: true };
      }
      const fileName = basename(absolute);
      const text = await extractDocumentBuffer(fileName, await readFile(absolute));
      const truncated = text.length > parsed.maxChars;
      return {
        content: [
          `文档: ${parsed.path}`,
          `字符数: ${text.length}${truncated ? `（已截断到 ${parsed.maxChars}）` : ""}`,
          "",
          text.slice(0, parsed.maxChars),
        ].join("\n"),
      };
    },
    inputSchema: toJsonSchema(readDocumentSchema),
    name: "read_document",
    parse: (input) => readDocumentSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `读取文档：${readDocumentSchema.parse(input).path}`,
  };
}

export function createViewPdfPageTool(options: DocumentToolOptions): Tool {
  return {
    description:
      "把 workspace 内 PDF 的指定页渲染成 PNG 并作为 image content 发给支持视觉的模型。页数上限 10000，渲染结果上限 8MB；需要运行环境提供 @napi-rs/canvas。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = viewPdfPageSchema.parse(input);
      if (!options.supportsImages()) {
        return { content: "当前模型不支持图片输入，无法查看 PDF 页面。", isError: true };
      }
      context.signal.throwIfAborted();
      const absolute = await resolvePath(context, parsed.path);
      const info = await stat(absolute);
      if (!info.isFile()) return { content: "目标不是文件。", isError: true };
      if (info.size > MAX_PDF_BYTES) return { content: "PDF 超过 30MB 限制。", isError: true };
      const buffer = await readFile(absolute);
      if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        return { content: "不是有效的 PDF 文件。", isError: true };
      }
      try {
        const inspection = await inspectPages(buffer);
        if (parsed.page > inspection.totalPages) {
          return {
            content: `页码超出范围（共 ${inspection.totalPages} 页）。`,
            isError: true,
          };
        }
        const rendered = await renderPageAsImage(buffer, parsed.page, {
          format: "png",
          scale: parsed.scale,
        });
        if (typeof rendered === "string") {
          return { content: "PDF 渲染返回了意外的数据格式。", isError: true };
        }
        if (rendered.byteLength > MAX_RENDERED_BYTES) {
          return { content: "渲染结果超过 8MB，请降低 scale。", isError: true };
        }
        return {
          content: `已渲染 ${parsed.path} 第 ${parsed.page}/${inspection.totalPages} 页（${Math.ceil(rendered.byteLength / 1024)}KB）。`,
          images: [{ data: Buffer.from(rendered).toString("base64"), mimeType: "image/png" }],
        };
      } catch (error: unknown) {
        return {
          content: `PDF 页面渲染失败：${
            error instanceof Error ? error.message : String(error)
          }。渲染需要 @napi-rs/canvas，请确认运行环境已安装。`,
          isError: true,
        };
      }
    },
    inputSchema: toJsonSchema(viewPdfPageSchema),
    name: "view_pdf_page",
    parse: (input) => viewPdfPageSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => {
      const parsed = viewPdfPageSchema.parse(input);
      return `查看 PDF 第 ${parsed.page} 页：${parsed.path}`;
    },
  };
}

async function resolvePath(context: ToolContext, path: string): Promise<string> {
  return resolveWorkspacePath({
    ...(context.protectedPaths === undefined ? {} : { protectedPaths: context.protectedPaths }),
    path,
    workspaceRoot: context.workspaceRoot,
  });
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
