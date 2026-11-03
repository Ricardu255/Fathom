import { randomUUID } from "node:crypto";
import type { KnowledgeHit } from "@harness/core";
import type { HarnessDatabase, MemoryRecord } from "../storage/database";
import {
  bytesToVector,
  cosineSimilarity,
  type Embedder,
  HashEmbedder,
  vectorToBytes,
} from "./embedder";

const MAX_CONTENT = 2_000;
const MAX_TITLE = 120;
const RRF_K = 60;

export class MemoryServiceError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "MemoryServiceError";
  }
}

export class MemoryService {
  private readonly embedder: Embedder;

  public constructor(
    private readonly options: {
      database: HarnessDatabase;
      embedder?: Embedder;
    },
  ) {
    this.embedder = options.embedder ?? new HashEmbedder();
  }

  public async initialize(): Promise<void> {
    const embedded = new Set(
      this.options.database.listMemoryEmbeddings(this.embedder.id).map((item) => item.chunkId),
    );
    for (const memory of this.options.database.listMemories()) {
      const chunkId = chunkIdFor(memory.id);
      if (!embedded.has(chunkId)) {
        try {
          await this.embed(chunkId, memory.content);
        } catch {
          // 向量服务不可用时保留关键词召回。
        }
      }
    }
  }

  public list(): MemoryRecord[] {
    return this.options.database.listMemories();
  }

  public get(id: string): MemoryRecord {
    const memory = this.options.database.getMemory(id);
    if (memory === null) throw new MemoryServiceError("NOT_FOUND", "记忆不存在");
    return memory;
  }

  public async create(input: {
    content: string;
    title?: string | undefined;
  }): Promise<MemoryRecord> {
    const content = input.content.trim();
    if (content === "" || content.length > MAX_CONTENT) {
      throw new MemoryServiceError("INVALID", `记忆内容必须为 1-${MAX_CONTENT} 个字符`);
    }
    const title = normalizeTitle(input.title, content);
    const id = randomUUID();
    await this.write(id, title, content);
    return this.get(id);
  }

  public async update(
    id: string,
    input: { content?: string | undefined; title?: string | undefined },
  ): Promise<MemoryRecord> {
    const current = this.get(id);
    const content = input.content === undefined ? current.content : input.content.trim();
    if (content === "" || content.length > MAX_CONTENT) {
      throw new MemoryServiceError("INVALID", `记忆内容必须为 1-${MAX_CONTENT} 个字符`);
    }
    const title = input.title === undefined ? current.title : normalizeTitle(input.title, content);
    await this.write(id, title, content);
    return this.get(id);
  }

  public delete(id: string): void {
    this.get(id);
    this.options.database.deleteKnowledgeDocument(documentIdFor(id));
  }

  /** FTS/BM25 + 本地向量召回，用 RRF 融合后返回统一 KnowledgeHit。 */
  public async search(query: string, limit = 8): Promise<readonly KnowledgeHit[]> {
    const normalized = query.trim();
    if (normalized === "") return [];
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const fts = this.options.database.searchKnowledge(normalized, safeLimit * 4, ["memory"]);
    const memories = new Map(
      this.options.database.listMemories().map((memory) => [documentIdFor(memory.id), memory]),
    );
    let vectorRanked: Array<{ documentId: string; score: number }> = [];
    try {
      const queryVector = await this.embedder.embed(normalized);
      vectorRanked = this.options.database
        .listMemoryEmbeddings(this.embedder.id)
        .map((item) => ({
          documentId: item.documentId,
          score: cosineSimilarity(queryVector, bytesToVector(item.vector)),
        }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, safeLimit * 4);
    } catch {
      // 语义服务暂时不可用时仍返回关键词结果。
    }

    const fused = new Map<string, { hit: KnowledgeHit; score: number }>();
    for (const [index, hit] of fts.entries()) {
      fused.set(hit.chunkId, { hit, score: 1 / (RRF_K + index + 1) });
    }
    for (const [index, candidate] of vectorRanked.entries()) {
      const memory = memories.get(candidate.documentId);
      if (memory === undefined) continue;
      const chunkId = chunkIdFor(memory.id);
      const existing = fused.get(chunkId);
      const contribution = 1 / (RRF_K + index + 1);
      if (existing !== undefined) {
        existing.score += contribution;
      } else {
        fused.set(chunkId, {
          hit: {
            chunkId,
            content: memory.content,
            documentId: documentIdFor(memory.id),
            documentTitle: memory.title,
            kind: "memory",
            pageEnd: 0,
            pageStart: 0,
            section: null,
            sourceId: memory.sourceId,
          },
          score: contribution,
        });
      }
    }
    return [...fused.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, safeLimit)
      .map((item) => item.hit);
  }

  public async recall(
    query: string,
    limit = 5,
  ): Promise<{ context: string; hits: readonly KnowledgeHit[] }> {
    const hits = await this.search(query, limit);
    if (hits.length === 0) return { context: "", hits };
    const lines = hits.map((hit, index) => `${index + 1}. [${hit.documentTitle}] ${hit.content}`);
    return {
      context: `相关长期记忆（可能与当前任务有关，仅作为参考）：\n${lines.join("\n")}`,
      hits,
    };
  }

  public async formatContext(query: string, limit = 8): Promise<string> {
    return (await this.recall(query, limit)).context;
  }

  private async write(id: string, title: string, content: string): Promise<void> {
    const documentId = documentIdFor(id);
    const chunkId = chunkIdFor(id);
    this.options.database.indexKnowledgeDocument(
      { id: documentId, kind: "memory", sourceId: null, title },
      [
        {
          content,
          id: chunkId,
          ordinal: 0,
          pageEnd: 0,
          pageStart: 0,
          section: null,
        },
      ],
    );
    await this.embed(chunkId, content);
  }

  private async embed(chunkId: string, content: string): Promise<void> {
    this.options.database.upsertKnowledgeEmbedding({
      chunkId,
      dimensions: this.embedder.dimensions,
      modelId: this.embedder.id,
      vector: vectorToBytes(await this.embedder.embed(content)),
    });
  }
}

function normalizeTitle(title: string | undefined, content: string): string {
  const trimmed = title?.trim() ?? "";
  const candidate = trimmed === "" ? content.replace(/\s+/gu, " ").slice(0, 60) : trimmed;
  return candidate.slice(0, MAX_TITLE);
}

function documentIdFor(id: string): string {
  return `memory:${id}`;
}

function chunkIdFor(id: string): string {
  return `memory:${id}:0`;
}
