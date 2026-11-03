import type { LiteratureReport } from "@harness/core/literature";

export type LiteratureExportFormat = "bibtex" | "json" | "markdown";

export interface LiteratureExport {
  content: string;
  contentType: string;
  extension: string;
}

const CONTENT_TYPES: Record<LiteratureExportFormat, string> = {
  bibtex: "application/x-bibtex; charset=utf-8",
  json: "application/json; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
};

const EXTENSIONS: Record<LiteratureExportFormat, string> = {
  bibtex: "bib",
  json: "json",
  markdown: "md",
};

export function exportLiterature(
  format: LiteratureExportFormat,
  report: LiteratureReport,
): LiteratureExport {
  return {
    content:
      format === "markdown"
        ? toMarkdown(report)
        : format === "bibtex"
          ? toBibtex(report)
          : `${JSON.stringify(report, null, 2)}\n`,
    contentType: CONTENT_TYPES[format],
    extension: EXTENSIONS[format],
  };
}

function toMarkdown(report: LiteratureReport): string {
  const lines: string[] = [`# ${report.title || "未命名文献"}`, ""];
  const metaBits = [
    report.authors.length > 0 ? `作者：${report.authors.join("、")}` : null,
    report.keywords.length > 0 ? `关键词：${report.keywords.join("、")}` : null,
  ].filter((item): item is string => item !== null);
  if (metaBits.length > 0) lines.push(metaBits.join("  \n"), "");
  if (report.meta !== undefined) {
    lines.push(
      `> 解析 ${report.meta.analyzedPages} 页 · ${report.meta.chunkCount} 个片段 · ${report.meta.model}`,
      `> 生成时间：${new Date(report.meta.generatedAt).toISOString()}`,
      ...(report.meta.truncated ? ["> 注意：原文较长，仅分析了前部分内容。"] : []),
      "",
    );
  }

  appendSection(lines, "摘要", report.summary.trim() === "" ? [] : [report.summary]);
  appendList(lines, "研究问题", report.researchQuestions);
  appendList(lines, "方法", report.methods);
  appendList(lines, "贡献", report.contributions);
  appendList(lines, "实验", report.experiments);
  appendList(lines, "局限", report.limitations);

  if (report.knowledgeChecklist.length > 0) {
    lines.push("## 知识清单", "");
    for (const item of report.knowledgeChecklist) {
      lines.push(`- **${item.importance}** ${item.item}${citationSuffix(item)}`);
    }
    lines.push("");
  }

  if (report.technicalRoute.length > 0) {
    lines.push("## 技术路线", "");
    for (const [index, step] of report.technicalRoute.entries()) {
      lines.push(`${index + 1}. **${step.step}**：${step.description}${citationSuffix(step)}`);
    }
    lines.push("");
  }

  if (report.innovations.length > 0) {
    lines.push("## 创新点", "");
    for (const innovation of report.innovations) {
      lines.push(
        `- **${innovation.title}**：${innovation.description}${citationSuffix(innovation)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "> 本文档由 Agent Harness 根据 PDF 自动整理；作者、年份与引用信息请在使用前人工核验。",
    "",
  );
  return lines.join("\n");
}

function appendSection(lines: string[], title: string, paragraphs: readonly string[]): void {
  if (paragraphs.length === 0) return;
  lines.push(`## ${title}`, "", ...paragraphs, "");
}

function appendList(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${title}`, "", ...items.map((item) => `- ${item}`), "");
}

function citationSuffix(item: {
  confidence?: "high" | "low" | "medium" | undefined;
  pages: readonly number[];
}): string {
  const pages =
    item.pages.length === 0
      ? ""
      : `（第 ${item.pages.join("、")} 页${item.confidence === undefined ? "" : `，置信度 ${item.confidence}`}）`;
  return pages;
}

function toBibtex(report: LiteratureReport): string {
  const key = `${slug(report.title).slice(0, 32) || "literature"}${yearSuffix(report)}`;
  const fields: string[] = [
    `  title = {${escapeBibtex(report.title)}}`,
    ...(report.authors.length > 0
      ? [`  author = {${report.authors.map(escapeBibtex).join(" and ")}}`]
      : []),
    ...(report.keywords.length > 0
      ? [`  keywords = {${report.keywords.map(escapeBibtex).join(", ")}}`]
      : []),
    "  year = {n.d.}",
    "  note = {自动解析生成；作者、年份与引用信息需人工核验。}",
  ];
  return `@article{${key},\n${fields.join(",\n")}\n}\n`;
}

function yearSuffix(report: LiteratureReport): string {
  if (report.meta === undefined) return "";
  return String(new Date(report.meta.generatedAt).getFullYear());
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function escapeBibtex(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/[\\{}%&#_$]/gu, (character) =>
      character === "\\" ? "\\textbackslash{}" : `\\${character}`,
    )
    .trim();
}
