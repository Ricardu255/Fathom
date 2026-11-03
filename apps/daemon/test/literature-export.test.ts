import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiteratureReport } from "@harness/core/literature";
import { exportLiterature } from "../src/literature/export";

function sampleReport(): LiteratureReport {
  return {
    authors: ["Ada Lovelace", "Alan Turing"],
    contributions: ["提出一种可验证的方法"],
    experiments: ["在两个数据集上验证"],
    innovations: [
      {
        confidence: "high",
        description: "把检索与生成解耦。",
        pages: [4],
        title: "解耦式检索",
      },
    ],
    keywords: ["agent", "retrieval"],
    knowledgeChecklist: [
      {
        confidence: "medium",
        importance: "high",
        item: "掌握核心指标的定義",
        pages: [2, 3],
      },
    ],
    limitations: ["仅在英文数据上验证"],
    meta: {
      analyzedPages: 8,
      chunkCount: 2,
      generatedAt: 1_700_000_000_000,
      model: "mock-model",
      outline: [{ level: 1, page: 1, title: "Introduction" }],
      truncated: false,
    },
    methods: ["对比实验"],
    researchQuestions: ["如何提升引用正确率？"],
    summary: "本文研究检索增强的可靠性。",
    technicalRoute: [
      {
        confidence: "high",
        description: "先切块，再检索。",
        pages: [3],
        step: "文档切块",
      },
    ],
    title: "Reliable Retrieval & Generation",
  };
}

test("Markdown 导出包含摘要、清单、技术路线与引用页码", () => {
  const artifact = exportLiterature("markdown", sampleReport());
  assert.equal(artifact.extension, "md");
  assert.match(artifact.content, /# Reliable Retrieval & Generation/u);
  assert.match(artifact.content, /## 摘要/u);
  assert.match(artifact.content, /## 知识清单/u);
  assert.match(artifact.content, /掌握核心指标的定義/u);
  assert.match(artifact.content, /第 2、3 页/u);
  assert.match(artifact.content, /## 技术路线/u);
  assert.match(artifact.content, /文档切块/u);
  assert.match(artifact.content, /人工核验/u);
});

test("JSON 导出是可直接回读的报告", () => {
  const report = sampleReport();
  const artifact = exportLiterature("json", report);
  assert.equal(artifact.extension, "json");
  assert.deepEqual(JSON.parse(artifact.content), report);
});

test("BibTeX 导出转义特殊字符并保留作者列表", () => {
  const artifact = exportLiterature("bibtex", sampleReport());
  assert.equal(artifact.extension, "bib");
  assert.match(artifact.content, /^@article\{/u);
  assert.match(artifact.content, /Reliable Retrieval \\& Generation/u);
  assert.match(artifact.content, /Ada Lovelace and Alan Turing/u);
  assert.match(artifact.content, /year = \{n\.d\.\}/u);
  assert.match(artifact.content, /note = \{自动解析生成/u);
});
