import { readFile, stat } from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "@harness/core";
import { resolveWorkspacePath } from "@harness/policy";
import { z } from "zod";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 4_096;

const viewImageSchema = z.object({
  path: z.string().min(1).max(1_024).describe("workspace 内的图片路径"),
});

export interface ViewImageOptions {
  supportsImages: () => boolean;
}

export function createViewImageTool(options: ViewImageOptions): Tool {
  return {
    description:
      "读取 workspace 内的 PNG/JPEG/GIF/WebP 图片并以 image content 发给模型。仅支持具备视觉能力的模型；单文件上限 8MB，边长上限 4096。",
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const parsed = viewImageSchema.parse(input);
      if (!options.supportsImages()) {
        return { content: "当前模型不支持图片输入，无法查看图片。", isError: true };
      }
      context.signal.throwIfAborted();
      const absolute = await resolveWorkspacePath({
        ...(context.protectedPaths === undefined ? {} : { protectedPaths: context.protectedPaths }),
        path: parsed.path,
        workspaceRoot: context.workspaceRoot,
      });
      const info = await stat(absolute);
      if (!info.isFile()) return { content: "目标不是文件。", isError: true };
      if (info.size > MAX_IMAGE_BYTES) {
        return {
          content: `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 限制。`,
          isError: true,
        };
      }
      const buffer = await readFile(absolute);
      const detected = detectImage(buffer);
      if (detected === null) {
        return { content: "不是受支持的图片格式（PNG/JPEG/GIF/WebP）。", isError: true };
      }
      if (
        detected.width !== null &&
        detected.height !== null &&
        (detected.width > MAX_DIMENSION || detected.height > MAX_DIMENSION)
      ) {
        return {
          content: `图片尺寸 ${detected.width}x${detected.height} 超过 ${MAX_DIMENSION} 边长限制。`,
          isError: true,
        };
      }
      const dimensions =
        detected.width === null || detected.height === null
          ? "尺寸未知"
          : `${detected.width}x${detected.height}`;
      return {
        content: `已加载图片 ${parsed.path}（${detected.mimeType}，${dimensions}，${Math.ceil(info.size / 1024)}KB）。`,
        images: [{ data: buffer.toString("base64"), mimeType: detected.mimeType }],
      };
    },
    inputSchema: toJsonSchema(viewImageSchema),
    name: "view_image",
    parse: (input) => viewImageSchema.parse(input),
    requiresApproval: false,
    summarize: (input) => `查看图片：${viewImageSchema.parse(input).path}`,
  };
}

interface ImageInfo {
  height: number | null;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  width: number | null;
}

export function detectImage(buffer: Buffer): ImageInfo | null {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      height: buffer.readUInt32BE(20),
      mimeType: "image/png",
      width: buffer.readUInt32BE(16),
    };
  }
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return {
      height: buffer.readUInt16LE(8),
      mimeType: "image/gif",
      width: buffer.readUInt16LE(6),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const size = jpegSize(buffer);
    return { height: size?.height ?? null, mimeType: "image/jpeg", width: size?.width ?? null };
  }
  if (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const size = webpSize(buffer);
    return { height: size?.height ?? null, mimeType: "image/webp", width: size?.width ?? null };
  }
  return null;
}

function jpegSize(buffer: Buffer): { height: number; width: number } | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer: Buffer): { height: number; width: number } | null {
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      height: 1 + buffer.readUIntLE(27, 3),
      width: 1 + buffer.readUIntLE(24, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      height: buffer.readUInt16LE(28) & 0x3fff,
      width: buffer.readUInt16LE(26) & 0x3fff,
    };
  }
  return null;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}
