export interface RetrievalCase {
  query: string;
  /** 期望被召回的知识文档 id，顺序无关。 */
  relevant: readonly string[];
}

export interface RetrievalMetrics {
  cases: number;
  /** 完全没召回到任何相关文档的用例。 */
  misses: readonly { query: string; ranked: readonly string[] }[];
  mrr: number;
  recallAt1: number;
  recallAt3: number;
  recallAtK: number;
}

/**
 * 单例召回率：前 k 个结果里命中的相关文档占全部相关文档的比例。
 * 多标签场景比「命中即算对」更有区分度。
 */
export function recallAtK(
  ranked: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, Math.max(0, k)));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** 第一个相关结果排在第几位；没命中记 0。 */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  if (relevant.length === 0) return 0;
  const wanted = new Set(relevant);
  const index = ranked.findIndex((id) => wanted.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

/**
 * 跑一遍固定查询集，给出可对比的数字。
 * 只依赖「查询 → 排序后的 id」这一步，所以换 embedder、换融合策略都能用同一套基线。
 */
export async function evaluateRetrieval(input: {
  cases: readonly RetrievalCase[];
  k?: number;
  search: (query: string) => Promise<readonly string[]> | readonly string[];
}): Promise<RetrievalMetrics> {
  const k = input.k ?? 5;
  if (input.cases.length === 0) {
    return { cases: 0, misses: [], mrr: 0, recallAt1: 0, recallAt3: 0, recallAtK: 0 };
  }
  let sumRecallK = 0;
  let sumRecall1 = 0;
  let sumRecall3 = 0;
  let sumRr = 0;
  const misses: { query: string; ranked: readonly string[] }[] = [];
  for (const one of input.cases) {
    const ranked = await input.search(one.query);
    sumRecallK += recallAtK(ranked, one.relevant, k);
    sumRecall1 += recallAtK(ranked, one.relevant, 1);
    sumRecall3 += recallAtK(ranked, one.relevant, 3);
    sumRr += reciprocalRank(ranked, one.relevant);
    if (recallAtK(ranked, one.relevant, k) === 0) {
      misses.push({ query: one.query, ranked: ranked.slice(0, k) });
    }
  }
  const count = input.cases.length;
  return {
    cases: count,
    misses,
    mrr: sumRr / count,
    recallAt1: sumRecall1 / count,
    recallAt3: sumRecall3 / count,
    recallAtK: sumRecallK / count,
  };
}
