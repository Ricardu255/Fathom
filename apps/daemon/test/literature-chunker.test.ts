import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiteratureReport, LiteratureTechnicalStep } from "@harness/core";
import { chunkDocument, detectOutline } from "../src/literature/chunker";
import { validateReportCitations } from "../src/literature/citations";

const CITATION_PAGES = [
  "The Transformer architecture relies on self attention mechanisms.",
  "Experiments on machine translation show significant improvements over baselines.",
];

function makeReport(overrides: Partial<LiteratureReport> = {}): LiteratureReport {
  return {
    authors: [],
    contributions: [],
    experiments: [],
    innovations: [],
    keywords: [],
    knowledgeChecklist: [],
    limitations: [],
    methods: [],
    researchQuestions: [],
    summary: "summary",
    technicalRoute: [],
    title: "Test Report",
    ...overrides,
  };
}

function technicalStep(pages: number[], evidence?: string): LiteratureTechnicalStep {
  return {
    description: "step description",
    evidence,
    pages,
    step: "step title",
  };
}

function filler(length: number, character = "x"): string {
  return character.repeat(length);
}

test("short documents produce a single chunk with the full page range and outline", () => {
  const pages = [
    "Abstract\nA short abstract.",
    "1 Introduction\nPrior work is reviewed.",
    "2.1 Method\nWe describe the method.",
  ];
  const result = chunkDocument(pages);

  assert.equal(result.chunks.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.analyzedPages, pages.length);
  assert.equal(
    result.totalCharacters,
    pages.reduce((total, page) => total + page.length, 0),
  );

  const chunk = result.chunks[0];
  assert.ok(chunk);
  assert.equal(chunk.pageStart, 1);
  assert.equal(chunk.pageEnd, 3);
  assert.equal(chunk.section, "Abstract");
  assert.match(chunk.text, /--- page 1 ---/u);
  assert.match(chunk.text, /--- page 3 ---/u);
  assert.deepEqual(
    result.outline.map((entry) => entry.title),
    ["Abstract", "1 Introduction", "2.1 Method"],
  );
});

test("detectOutline recognizes named, numbered, dotted-numbered, and Chinese headings", () => {
  const outline = detectOutline([
    "Abstract\nThis paper presents a study",
    "1 Introduction\nPrior work is reviewed here",
    "2.1 Method\nWe describe the method",
    "一、引言\n本文研究",
  ]);

  assert.deepEqual(
    outline.map((entry) => entry.title),
    ["Abstract", "1 Introduction", "2.1 Method", "一、引言"],
  );
  assert.deepEqual(
    outline.map((entry) => entry.page),
    [1, 2, 3, 4],
  );
});

test("detectOutline ignores prose and period-terminated lines and dedupes consecutive headings", () => {
  const ignored = detectOutline([
    "The results are shown in Figure 1\nA plain sentence without punctuation",
    "Introduction.\nResults.\nMethod, with commas and many more words than allowed here",
  ]);
  assert.deepEqual(ignored, []);

  const deduped = detectOutline(["Introduction\nIntroduction\n1. Background\n1. Background"]);
  assert.deepEqual(
    deduped.map((entry) => entry.title),
    ["Introduction", "1. Background"],
  );
});

test("long documents produce multiple continuous page-covering chunks with bounded text", () => {
  const pages = Array.from({ length: 5 }, (_, index) =>
    filler(15_000, String.fromCharCode(97 + index)),
  );
  const result = chunkDocument(pages);

  assert.ok(result.totalCharacters > 60_000);
  assert.ok(result.chunks.length > 1);
  assert.equal(result.truncated, false);
  assert.equal(result.analyzedPages, pages.length);

  let previousEnd = 0;
  for (const [index, chunk] of result.chunks.entries()) {
    assert.equal(chunk.index, index);
    assert.ok(chunk.pageStart <= chunk.pageEnd);
    assert.equal(chunk.pageStart, index === 0 ? 1 : previousEnd + 1);
    assert.match(chunk.text, /--- page \d+ ---/u);
    assert.ok(chunk.text.length <= 36_100, `chunk ${index} is too large: ${chunk.text.length}`);
    previousEnd = chunk.pageEnd;
  }
  assert.equal(previousEnd, pages.length);
  assert.equal(result.chunks.at(-1)?.pageEnd, pages.length);
});

test("documents that exceed the chunk budget are marked truncated", () => {
  const pages = Array.from({ length: 20 }, () => filler(20_000, "z"));
  const result = chunkDocument(pages);

  assert.ok(result.totalCharacters > 60_000);
  assert.equal(result.truncated, true);
  assert.ok(result.analyzedPages < pages.length);
  assert.equal(result.analyzedPages, result.chunks.at(-1)?.pageEnd);
  assert.ok(result.chunks.length > 0);
  for (const chunk of result.chunks) {
    assert.ok(chunk.pageStart <= chunk.pageEnd);
  }
});

test("an oversized page is split into parts that keep the same page number", () => {
  const paragraph = filler(15_000, "x");
  const oversizedPage = [paragraph, paragraph, paragraph].join("\n");
  const result = chunkDocument([oversizedPage, filler(16_000, "y")]);

  assert.ok(oversizedPage.length > 36_000);
  assert.ok(result.totalCharacters > 60_000);

  const pageOneChunks = result.chunks.filter((chunk) => chunk.text.includes("--- page 1 (part "));
  assert.ok(
    pageOneChunks.length >= 2,
    `expected multiple parts for page 1, got ${pageOneChunks.length}`,
  );
  for (const chunk of pageOneChunks) {
    assert.equal(chunk.pageStart, 1);
    assert.equal(chunk.pageEnd, 1);
  }

  const partMarkers = new Set(
    pageOneChunks.flatMap((chunk) => chunk.text.match(/--- page 1 \(part \d+\) ---/gu) ?? []),
  );
  assert.ok(partMarkers.size >= 2);

  const pageTwo = result.chunks.find((chunk) => chunk.text.includes("--- page 2 ---"));
  assert.ok(pageTwo);
  assert.equal(pageTwo.pageStart, 2);
  assert.equal(pageTwo.pageEnd, 2);
});

test("validateReportCitations drops out-of-range pages and marks fully invalid citations missing", () => {
  const report = makeReport({
    technicalRoute: [
      technicalStep([0, 99], "some evidence text that is long enough"),
      technicalStep([1, 99], "Transformer architecture relies on self attention"),
    ],
  });

  const result = validateReportCitations(report, CITATION_PAGES);
  const [invalid, partiallyInvalid] = result.report.technicalRoute;
  assert.ok(invalid);
  assert.ok(partiallyInvalid);

  assert.equal(invalid.citationStatus, "missing");
  assert.equal(invalid.confidence, "low");
  assert.deepEqual(invalid.pages, []);

  assert.equal(partiallyInvalid.citationStatus, "verified");
  assert.equal(partiallyInvalid.confidence, "high");
  assert.deepEqual(partiallyInvalid.pages, [1]);

  assert.equal(result.missing, 1);
  assert.equal(result.verified, 1);
  assert.equal(result.unverified, 0);
});

test("validateReportCitations marks citations without evidence unverified at medium confidence", () => {
  const report = makeReport({ technicalRoute: [technicalStep([2])] });

  const result = validateReportCitations(report, CITATION_PAGES);
  const item = result.report.technicalRoute[0];
  assert.ok(item);

  assert.equal(item.citationStatus, "unverified");
  assert.equal(item.confidence, "medium");
  assert.deepEqual(item.pages, [2]);
  assert.equal(result.unverified, 1);
  assert.equal(result.verified, 0);
  assert.equal(result.missing, 0);
});

test("validateReportCitations verifies evidence found on a cited page", () => {
  const report = makeReport({
    innovations: [
      {
        description: "innovation description",
        evidence: "Transformer architecture relies on self attention",
        pages: [1],
        title: "innovation title",
      },
    ],
  });

  const result = validateReportCitations(report, CITATION_PAGES);
  const item = result.report.innovations[0];
  assert.ok(item);

  assert.equal(item.citationStatus, "verified");
  assert.equal(item.confidence, "high");
  assert.deepEqual(item.pages, [1]);
  assert.equal(result.verified, 1);
  assert.equal(result.unverified, 0);
  assert.equal(result.missing, 0);
});

test("validateReportCitations adds the page where the evidence was actually found", () => {
  const report = makeReport({
    technicalRoute: [
      technicalStep([1], "Experiments on machine translation show significant improvements"),
    ],
  });

  const result = validateReportCitations(report, CITATION_PAGES);
  const item = result.report.technicalRoute[0];
  assert.ok(item);

  assert.equal(item.citationStatus, "verified");
  assert.equal(item.confidence, "high");
  assert.deepEqual(item.pages, [1, 2]);
  assert.equal(result.verified, 1);
  assert.equal(result.unverified, 0);
});

test("validateReportCitations marks evidence absent from the whole document unverified at low confidence", () => {
  const report = makeReport({
    knowledgeChecklist: [
      {
        evidence: "quantum annealing solves protein folding problems",
        importance: "high",
        item: "checklist item",
        pages: [1],
      },
    ],
  });

  const result = validateReportCitations(report, CITATION_PAGES);
  const item = result.report.knowledgeChecklist[0];
  assert.ok(item);

  assert.equal(item.citationStatus, "unverified");
  assert.equal(item.confidence, "low");
  assert.deepEqual(item.pages, [1]);
  assert.equal(result.unverified, 1);
  assert.equal(result.verified, 0);
});

test("validateReportCitations returns a new report without mutating its input", () => {
  const originalStep = technicalStep([1], "Transformer architecture relies on self attention");
  const report = makeReport({ technicalRoute: [originalStep] });
  const snapshot = structuredClone(report);

  const result = validateReportCitations(report, CITATION_PAGES);

  assert.notEqual(result.report, report);
  assert.notEqual(result.report.technicalRoute, report.technicalRoute);
  assert.notEqual(result.report.innovations, report.innovations);
  assert.notEqual(result.report.technicalRoute[0], report.technicalRoute[0]);
  assert.deepEqual(report, snapshot);
  assert.equal(report.technicalRoute[0]?.citationStatus, undefined);
  assert.equal(result.report.technicalRoute[0]?.citationStatus, "verified");
});
