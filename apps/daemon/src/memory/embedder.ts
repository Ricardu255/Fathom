export interface Embedder {
  readonly dimensions: number;
  readonly id: string;
  embed(text: string): Promise<Float32Array>;
}

const DIMENSIONS = 256;

/**
 * 离线、确定性的字符 n-gram 哈希向量。
 * 它提供的是词形/字符级相似度，不是语义 embedding；接口保持稳定，
 * 后续可以替换为本地 ONNX 模型而不改检索服务。
 */
export class HashEmbedder implements Embedder {
  public readonly dimensions = DIMENSIONS;
  public readonly id = "hash-ngram-v1";

  public async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(DIMENSIONS);
    for (const token of tokenize(text)) {
      const slot = fnv1a(token) % DIMENSIONS;
      const sign = (fnv1a(`sign:${token}`) & 1) === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let index = 0; index < vector.length; index += 1) {
        vector[index] = (vector[index] ?? 0) / norm;
      }
    }
    return vector;
  }
}

export interface HttpEmbedderOptions {
  apiKey?: string | undefined;
  dimensions: number;
  model: string;
  url: string;
}

/** OpenAI-compatible `/embeddings` 端点；命中失败时由 MemoryService 退化为 FTS。 */
export class HttpEmbedder implements Embedder {
  public readonly dimensions: number;
  public readonly id: string;

  public constructor(private readonly options: HttpEmbedderOptions) {
    this.dimensions = options.dimensions;
    this.id = `http:${options.model}:${options.dimensions}`;
  }

  public async embed(text: string): Promise<Float32Array> {
    const endpoint = new URL(
      this.options.url.endsWith("/")
        ? `${this.options.url}embeddings`
        : `${this.options.url}/embeddings`,
    );
    const response = await fetch(endpoint, {
      body: JSON.stringify({ input: text, model: this.options.model }),
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${this.options.apiKey}` }),
      },
      method: "POST",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const raw = body.data?.[0]?.embedding;
    if (!Array.isArray(raw)) throw new Error("Embedding 响应缺少向量");
    const vector = new Float32Array(raw.map((value) => Number(value)));
    if (vector.length !== this.dimensions) {
      throw new Error(`Embedding 维度不匹配：${vector.length} != ${this.dimensions}`);
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let index = 0; index < vector.length; index += 1) {
        vector[index] = (vector[index] ?? 0) / norm;
      }
    }
    return vector;
  }
}

export function vectorToBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0));
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function tokenize(text: string): string[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9]+/gu)) {
    const word = match[0];
    tokens.push(word);
    if (word.length > 3) {
      for (let index = 0; index <= word.length - 3; index += 1) {
        tokens.push(word.slice(index, index + 3));
      }
    }
  }
  const characters = [...normalized].filter((character) => /[\p{Script=Han}]/u.test(character));
  tokens.push(...characters);
  for (let index = 0; index < characters.length - 1; index += 1) {
    tokens.push(`${characters[index]}${characters[index + 1]}`);
  }
  return tokens;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
