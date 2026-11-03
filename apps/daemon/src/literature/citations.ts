import type {
  LiteratureChecklistItem,
  LiteratureInnovation,
  LiteratureReport,
  LiteratureTechnicalStep,
} from "@harness/core";

export interface CitationValidationSummary {
  missing: number;
  report: LiteratureReport;
  unverified: number;
  verified: number;
}

interface CitedItem {
  citationStatus?: "missing" | "unverified" | "verified" | undefined;
  confidence?: "high" | "low" | "medium" | undefined;
  evidence?: string | undefined;
  pages: number[];
}

/**
 * 确定性引用校验：
 * - 页码必须落在原文范围；
 * - 有 evidence 时，规范化后检查它是否真的出现在引用页；
 * - 找不到依据的条目标为 unverified/low，而不是删除（保留给用户核对）。
 */
export function validateReportCitations(
  report: LiteratureReport,
  pages: readonly string[],
): CitationValidationSummary {
  const normalizedPages = pages.map(normalizeText);
  let verified = 0;
  let unverified = 0;
  let missing = 0;

  const validate = <T extends CitedItem>(item: T): T => {
    const originalPages = Array.isArray(item.pages) ? item.pages : [];
    const validPages = [
      ...new Set(originalPages.filter((page) => page >= 1 && page <= pages.length)),
    ].sort((left, right) => left - right);
    const evidence = typeof item.evidence === "string" ? item.evidence.trim().slice(0, 500) : "";

    if (validPages.length === 0) {
      missing += 1;
      return {
        ...item,
        citationStatus: "missing",
        confidence: "low",
        pages: validPages,
      };
    }

    if (evidence === "") {
      unverified += 1;
      return {
        ...item,
        citationStatus: "unverified",
        ...(item.confidence === undefined ? { confidence: "medium" as const } : {}),
        pages: validPages,
      };
    }

    const needle = normalizeText(evidence);
    const citedMatch =
      needle.length >= 8 && validPages.some((page) => normalizedPages[page - 1]?.includes(needle));
    if (citedMatch) {
      verified += 1;
      return {
        ...item,
        citationStatus: "verified",
        confidence: "high",
        evidence,
        pages: validPages,
      };
    }

    // 证据不在引用页时，尝试在全文里找到它，并补齐页码；仍找不到则标记低置信。
    const actualPage =
      needle.length >= 8 ? normalizedPages.findIndex((page) => page.includes(needle)) + 1 : 0;
    const resolvedPages =
      actualPage > 0 && !validPages.includes(actualPage)
        ? [...validPages, actualPage].sort((left, right) => left - right)
        : validPages;
    if (actualPage > 0) {
      verified += 1;
      return {
        ...item,
        citationStatus: "verified",
        confidence: "high",
        evidence,
        pages: resolvedPages,
      };
    }
    unverified += 1;
    return {
      ...item,
      citationStatus: "unverified",
      confidence: "low",
      evidence,
      pages: validPages,
    };
  };

  const technicalRoute: LiteratureTechnicalStep[] = report.technicalRoute.map(validate);
  const innovations: LiteratureInnovation[] = report.innovations.map(validate);
  const knowledgeChecklist: LiteratureChecklistItem[] = report.knowledgeChecklist.map(validate);

  return {
    missing,
    report: { ...report, innovations, knowledgeChecklist, technicalRoute },
    unverified,
    verified,
  };
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 20_000);
}
