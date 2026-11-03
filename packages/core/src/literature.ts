export type LiteratureConfidence = "high" | "low" | "medium";

export type CitationStatus = "missing" | "unverified" | "verified";

export interface LiteratureCitation {
  /** OCR/抽取后的证据片段；有它时可以做引用校验。 */
  evidence?: string | undefined;
  pages: number[];
  /** 校验后的置信度；缺省表示尚未校验。 */
  confidence?: LiteratureConfidence | undefined;
  citationStatus?: CitationStatus | undefined;
}

export interface LiteratureTechnicalStep extends LiteratureCitation {
  description: string;
  step: string;
}

export interface LiteratureInnovation extends LiteratureCitation {
  description: string;
  title: string;
}

export interface LiteratureChecklistItem extends LiteratureCitation {
  importance: "high" | "medium" | "low";
  item: string;
}

export interface LiteratureOutlineEntry {
  level: number;
  page: number;
  title: string;
}

export interface LiteratureReportMeta {
  analyzedPages: number;
  chunkCount: number;
  generatedAt: number;
  model: string;
  outline: LiteratureOutlineEntry[];
  truncated: boolean;
}

export interface LiteratureReport {
  authors: string[];
  contributions: string[];
  experiments: string[];
  innovations: LiteratureInnovation[];
  keywords: string[];
  knowledgeChecklist: LiteratureChecklistItem[];
  limitations: string[];
  meta?: LiteratureReportMeta | undefined;
  methods: string[];
  researchQuestions: string[];
  summary: string;
  technicalRoute: LiteratureTechnicalStep[];
  title: string;
}
