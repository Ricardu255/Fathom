export type KnowledgeDocumentKind = "literature" | "memory" | "workspace";

export interface KnowledgeHit {
  chunkId: string;
  content: string;
  documentId: string;
  documentTitle: string;
  kind: KnowledgeDocumentKind;
  pageEnd: number;
  pageStart: number;
  section: string | null;
  sourceId: string | null;
}

export type KnowledgeSearch = (
  query: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<readonly KnowledgeHit[]>;
