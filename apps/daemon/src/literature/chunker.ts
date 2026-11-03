import type { LiteratureOutlineEntry } from "@harness/core";

export interface LiteratureChunk {
  id: string;
  index: number;
  pageEnd: number;
  pageStart: number;
  section: string | null;
  text: string;
}

export interface ChunkedDocument {
  analyzedPages: number;
  chunks: LiteratureChunk[];
  outline: LiteratureOutlineEntry[];
  totalCharacters: number;
  truncated: boolean;
}

export interface ChunkOptions {
  maxChunks?: number;
  singlePassLimit?: number;
  targetChars?: number;
}

const SINGLE_PASS_CHARACTER_LIMIT = 60_000;
const TARGET_CHUNK_CHARACTERS = 18_000;
const MAX_CHUNKS = 16;
const MAX_OUTLINE_ENTRIES = 80;

const NAMED_HEADINGS =
  /^(abstract|introduction|related work|background|motivation|method|methods|methodology|approach|system design|experiments?|evaluation|results?|discussion|conclusions?|limitations|future work|references|acknowledg(e)?ments?|摘要|引言|相关工作|背景|方法|实验|结果|讨论|结论|局限|未来工作|参考文献)\b/iu;
const NUMBERED_HEADING = /^(\d+(?:\.\d+){0,3})[.)]?\s+(.+)$/u;
const CHINESE_NUMBERED_HEADING = /^([一二三四五六七八九十]+)[、.]\s*(.+)$/u;

/**
 * 按页切块，并做启发式章节识别。
 * 页码始终是原文页码；块文本里保留 `--- page N ---` 标记，模型引用绝对页码。
 */
export function chunkDocument(
  pages: readonly string[],
  options: ChunkOptions = {},
): ChunkedDocument {
  const maxChunks = options.maxChunks ?? MAX_CHUNKS;
  const targetChars = options.targetChars ?? TARGET_CHUNK_CHARACTERS;
  const singlePassLimit = options.singlePassLimit ?? SINGLE_PASS_CHARACTER_LIMIT;
  const outline = detectOutline(pages);
  const totalCharacters = pages.reduce((total, page) => total + page.length, 0);

  if (totalCharacters <= singlePassLimit) {
    return {
      analyzedPages: pages.length,
      chunks: [
        {
          id: "chunk-1",
          index: 0,
          pageEnd: pages.length,
          pageStart: pages.length === 0 ? 0 : 1,
          section: outline[0]?.title ?? null,
          text: buildPageText(pages, 1, pages.length),
        },
      ],
      outline,
      totalCharacters,
      truncated: false,
    };
  }

  const chunks: LiteratureChunk[] = [];
  let current: { pageEnd: number; pageStart: number; parts: string[]; size: number } | null = null;

  const flush = () => {
    if (current === null) return;
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      index: chunks.length,
      pageEnd: current.pageEnd,
      pageStart: current.pageStart,
      section: sectionAt(outline, current.pageStart),
      text: current.parts.join("\n\n"),
    });
    current = null;
  };

  for (const [index, page] of pages.entries()) {
    if (chunks.length >= maxChunks) break;
    const pageNumber = index + 1;
    const pageParts = splitOversizedPage(page, pageNumber, targetChars);
    for (const part of pageParts) {
      if (chunks.length >= maxChunks) break;
      if (current !== null && current.size + part.length > targetChars) {
        flush();
        if (chunks.length >= maxChunks) break;
      }
      if (current === null) {
        current = { pageEnd: pageNumber, pageStart: pageNumber, parts: [], size: 0 };
      }
      current.parts.push(part);
      current.size += part.length;
      current.pageEnd = pageNumber;
    }
  }
  if (chunks.length < maxChunks) flush();

  const analyzedPages = chunks.at(-1)?.pageEnd ?? 0;
  return {
    analyzedPages,
    chunks,
    outline,
    totalCharacters,
    truncated: analyzedPages < pages.length,
  };
}

export function detectOutline(pages: readonly string[]): LiteratureOutlineEntry[] {
  const outline: LiteratureOutlineEntry[] = [];
  for (const [index, page] of pages.entries()) {
    for (const line of page.split(/\r?\n/u)) {
      if (outline.length >= MAX_OUTLINE_ENTRIES) return outline;
      const heading = detectHeading(line);
      if (heading === null) continue;
      const previous = outline.at(-1);
      if (previous?.title === heading.title) continue;
      outline.push({ level: heading.level, page: index + 1, title: heading.title });
    }
  }
  return outline;
}

function detectHeading(rawLine: string): { level: number; title: string } | null {
  const line = rawLine.trim().replace(/\s+/gu, " ");
  if (line.length < 3 || line.length > 100) return null;
  if (line.endsWith(".") || line.endsWith("。") || line.endsWith("?") || line.endsWith("？")) {
    return null;
  }
  if (line.split(" ").length > 14) return null;
  if (/[,;，；]/u.test(line) && line.split(" ").length > 8) return null;

  const named = NAMED_HEADINGS.exec(line);
  if (named !== null) return { level: 1, title: line };

  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered !== null) {
    const title = numbered[2]?.trim() ?? "";
    if (!looksLikeTitle(title)) return null;
    return { level: (numbered[1]?.split(".").length ?? 1) + 1, title: line };
  }

  const chinese = CHINESE_NUMBERED_HEADING.exec(line);
  if (chinese !== null) {
    const title = chinese[2]?.trim() ?? "";
    if (!looksLikeTitle(title)) return null;
    return { level: 1, title: line };
  }

  return null;
}

function looksLikeTitle(value: string): boolean {
  if (value.length < 2 || value.length > 90) return false;
  if (!/[\p{L}]/u.test(value)) return false;
  if (/[。！？.!?]$/u.test(value)) return false;
  return true;
}

function sectionAt(outline: readonly LiteratureOutlineEntry[], page: number): string | null {
  let title: string | null = null;
  for (const entry of outline) {
    if (entry.page > page) break;
    title = entry.title;
  }
  return title;
}

function buildPageText(pages: readonly string[], start: number, end: number): string {
  return pages
    .slice(start - 1, end)
    .map((page, index) => `--- page ${start + index} ---\n${page}`)
    .join("\n\n");
}

function splitOversizedPage(page: string, pageNumber: number, targetChars: number): string[] {
  const maximum = targetChars * 2;
  if (page.length <= maximum) return [`--- page ${pageNumber} ---\n${page}`];

  const lines = page.split(/\r?\n/u);
  const parts: string[] = [];
  let current = "";
  let part = 1;
  for (const line of lines) {
    if (current.length + line.length + 1 > targetChars && current.length > 0) {
      parts.push(`--- page ${pageNumber} (part ${part}) ---\n${current.trim()}`);
      current = "";
      part += 1;
    }
    current += `${line}\n`;
  }
  if (current.trim() !== "") {
    parts.push(`--- page ${pageNumber} (part ${part}) ---\n${current.trim()}`);
  }
  return parts;
}
