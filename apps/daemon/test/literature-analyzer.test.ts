import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelClient, ModelRequest, ModelResult } from "@harness/core";
import { loadConfig } from "../src/config";
import { analyzeDocument } from "../src/literature/analyzer";
import type { ChunkedDocument, LiteratureChunk } from "../src/literature/chunker";
import { LiteratureService } from "../src/services/literature-service";
import { HarnessDatabase, type LiteratureRecord } from "../src/storage/database";

const MAP_MARKER = "[[LITERATURE_MAP]]";
const REDUCE_MARKER = "[[LITERATURE_REDUCE]]";
const REPORT_MARKER = "[[LITERATURE_REPORT]]";

const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 10_000;

type Handler = (request: ModelRequest, index: number) => string | Promise<string>;

/** 只回放脚本化文本的 ModelClient，不触碰网络。 */
class ScriptedModelClient implements ModelClient {
  public readonly calls: ModelRequest[] = [];
  private readonly handler: Handler;

  public constructor(handler: Handler) {
    this.handler = handler;
  }

  public async stream(
    request: ModelRequest,
    onTextDelta: (text: string) => void,
  ): Promise<ModelResult> {
    const index = this.calls.length;
    this.calls.push(request);
    const text = await this.handler(request, index);
    onTextDelta(text);
    return { content: [{ text, type: "text" }], stopReason: "end_turn" };
  }

  public callsWith(marker: string): ModelRequest[] {
    return this.calls.filter((request) => request.system.includes(marker));
  }
}

function reportJson(title = "测试文献报告"): string {
  return JSON.stringify({
    authors: ["作者甲"],
    contributions: ["提出一种方法", "完成实验验证"],
    experiments: ["与基线对比"],
    innovations: [{ description: "核心创新描述", pages: [1], title: "核心创新" }],
    keywords: ["测试", "文献"],
    knowledgeChecklist: [{ importance: "high", item: "核心问题", pages: [1] }],
    limitations: ["样本有限"],
    methods: ["分块抽取"],
    researchQuestions: ["如何汇总长文档？"],
    summary: "这是一份测试报告。",
    technicalRoute: [{ description: "先分块再汇总", pages: [1], step: "分块" }],
    title,
  });
}

function mapJson(): string {
  return JSON.stringify({
    claims: [{ evidence: "模型给出的证据", pages: [1], text: "片段结论" }],
    experiments: ["片段实验"],
    innovations: [{ description: "片段创新描述", evidence: "证据", pages: [1], title: "片段创新" }],
    keyPoints: ["片段要点"],
    limitations: ["片段局限"],
    methods: ["片段方法"],
    steps: [{ description: "片段步骤描述", evidence: "证据", pages: [1], step: "片段步骤" }],
  });
}

function singleChunked(): ChunkedDocument {
  return {
    analyzedPages: 2,
    chunks: [
      {
        id: "chunk-1",
        index: 0,
        pageEnd: 2,
        pageStart: 1,
        section: "摘要",
        text: "--- page 1 ---\n第一页正文\n\n--- page 2 ---\n第二页正文",
      },
    ],
    outline: [{ level: 1, page: 1, title: "摘要" }],
    totalCharacters: 120,
    truncated: false,
  };
}

function multiChunked(count: number, truncated = false): ChunkedDocument {
  const chunks: LiteratureChunk[] = [];
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      id: `chunk-${index + 1}`,
      index,
      pageEnd: (index + 1) * 10,
      pageStart: index * 10 + 1,
      section: index === 0 ? "Introduction" : null,
      text: `--- page ${index * 10 + 1} ---\n第 ${index + 1} 个片段正文`,
    });
  }
  return {
    analyzedPages: count * 10,
    chunks,
    outline: [{ level: 1, page: 1, title: "Introduction" }],
    totalCharacters: count * 1_000,
    truncated,
  };
}

function abortError(): Error {
  const error = new Error("Request was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可被 AbortSignal 中断的延迟，用于服务层取消测试。 */
function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitFor<T>(label: string, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时（${POLL_TIMEOUT_MS}ms）: ${label}`);
    await delay(POLL_INTERVAL_MS);
  }
}

test("单片段：一次报告调用并补齐 meta 与进度", async () => {
  const progress: [string, number][] = [];
  const client = new ScriptedModelClient((request) => {
    assert.ok(request.system.includes(REPORT_MARKER), "单片段应使用报告系统提示词");
    return reportJson("单片段报告");
  });

  const report = await analyzeDocument({
    chunked: singleChunked(),
    maxTokens: 4_000,
    model: "test-model",
    modelClient: client,
    onProgress: (stage, value) => progress.push([stage, value]),
    pages: ["第一页正文", "第二页正文"],
    signal: new AbortController().signal,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.callsWith(MAP_MARKER).length, 0);
  assert.equal(client.callsWith(REDUCE_MARKER).length, 0);
  assert.equal(client.calls[0]?.maxTokens, 4_000);
  assert.equal(report.title, "单片段报告");
  assert.ok(report.meta !== undefined);
  assert.equal(report.meta.chunkCount, 1);
  assert.equal(report.meta.analyzedPages, 2);
  assert.equal(report.meta.truncated, false);
  assert.equal(report.meta.model, "test-model");
  assert.deepEqual(report.meta.outline, [{ level: 1, page: 1, title: "摘要" }]);
  assert.equal(typeof report.meta.generatedAt, "number");
  assert.ok(report.meta.generatedAt > 0);
  assert.deepEqual(progress, [["analyzing", 25]]);
});

test("map-reduce：逐片段映射后汇总一次", async () => {
  const progress: [string, number][] = [];
  let mapCalls = 0;
  let reduceCalls = 0;
  const client = new ScriptedModelClient((request) => {
    if (request.system.includes(MAP_MARKER)) {
      mapCalls += 1;
      return mapJson();
    }
    if (request.system.includes(REDUCE_MARKER)) {
      reduceCalls += 1;
      return reportJson("汇总报告");
    }
    throw new Error(`未预期的系统提示词: ${request.system.slice(0, 40)}`);
  });

  const chunked = multiChunked(3, true);
  const report = await analyzeDocument({
    chunked,
    maxTokens: 8_000,
    model: "test-model",
    modelClient: client,
    onProgress: (stage, value) => progress.push([stage, value]),
    pages: ["第一页", "第二页", "第三页"],
    signal: new AbortController().signal,
  });

  assert.equal(mapCalls, 3);
  assert.equal(reduceCalls, 1);
  assert.equal(client.calls.length, 4);
  assert.equal(client.callsWith(MAP_MARKER).length, 3);
  assert.equal(client.callsWith(REDUCE_MARKER).length, 1);
  // map 的 maxTokens 被压到 4000 以内。
  for (const call of client.callsWith(MAP_MARKER)) assert.equal(call.maxTokens, 4_000);
  assert.equal(report.title, "汇总报告");
  assert.ok(report.meta !== undefined);
  assert.equal(report.meta.chunkCount, 3);
  assert.equal(report.meta.analyzedPages, 30);
  assert.equal(report.meta.truncated, true);
  assert.deepEqual(report.meta.outline, [{ level: 1, page: 1, title: "Introduction" }]);
  assert.deepEqual(progress, [
    ["mapping", 10],
    ["mapping", 28],
    ["mapping", 47],
    ["reducing", 72],
  ]);
});

test("reduce 失败时返回自动回退报告且不抛出", async () => {
  const warnings: string[] = [];
  const client = new ScriptedModelClient((request) => {
    if (request.system.includes(MAP_MARKER)) return mapJson();
    if (request.system.includes(REDUCE_MARKER)) throw new Error("reduce boom");
    throw new Error("未预期的系统提示词");
  });

  const report = await analyzeDocument({
    chunked: multiChunked(3),
    maxTokens: 8_000,
    model: "test-model",
    modelClient: client,
    onProgress: () => undefined,
    onWarning: (message) => warnings.push(message),
    pages: ["第一页", "第二页", "第三页"],
    signal: new AbortController().signal,
  });

  assert.equal(client.callsWith(REDUCE_MARKER).length, 1);
  assert.match(report.summary, /自动回退/u);
  assert.ok(report.meta !== undefined);
  assert.equal(report.meta.chunkCount, 3);
  assert.ok(report.innovations.length > 0);
  assert.ok(report.knowledgeChecklist.length > 0);
  assert.ok(report.technicalRoute.length > 0);
  for (const innovation of report.innovations) assert.equal(innovation.confidence, "low");
  for (const item of report.knowledgeChecklist) assert.equal(item.confidence, "low");
  for (const step of report.technicalRoute) assert.equal(step.confidence, "low");
  assert.ok(warnings.some((message) => message.includes("汇总失败")));
});

test("所有 map 都失败时 analyzeDocument 拒绝", async () => {
  const warnings: string[] = [];
  const client = new ScriptedModelClient((request) => {
    if (request.system.includes(MAP_MARKER)) throw new Error("map boom");
    throw new Error("不应调用 reduce");
  });

  await assert.rejects(
    analyzeDocument({
      chunked: multiChunked(3),
      maxTokens: 8_000,
      model: "test-model",
      modelClient: client,
      onProgress: () => undefined,
      onWarning: (message) => warnings.push(message),
      pages: ["第一页", "第二页", "第三页"],
      signal: new AbortController().signal,
    }),
    /所有文献片段抽取都失败了/u,
  );

  assert.equal(client.callsWith(MAP_MARKER).length, 3);
  assert.equal(client.callsWith(REDUCE_MARKER).length, 0);
  assert.equal(warnings.filter((message) => message.includes("已跳过")).length, 3);
});

test("signal 预先中止时以 AbortError 拒绝且不调用模型", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new ScriptedModelClient(() => {
    throw new Error("不应调用模型");
  });

  await assert.rejects(
    analyzeDocument({
      chunked: multiChunked(2),
      maxTokens: 8_000,
      model: "test-model",
      modelClient: client,
      onProgress: () => undefined,
      pages: ["第一页", "第二页"],
      signal: controller.signal,
    }),
    isAbortError,
  );

  assert.equal(controller.signal.aborted, true);
  assert.equal(client.calls.length, 0);
});

test("map 调用期间中止时以 AbortError 拒绝并停止后续阶段", async () => {
  const controller = new AbortController();
  const client = new ScriptedModelClient((request) => {
    if (request.system.includes(MAP_MARKER)) {
      controller.abort();
      throw abortError();
    }
    throw new Error("不应继续调用");
  });

  await assert.rejects(
    analyzeDocument({
      chunked: multiChunked(3),
      maxTokens: 8_000,
      model: "test-model",
      modelClient: client,
      onProgress: () => undefined,
      pages: ["第一页", "第二页", "第三页"],
      signal: controller.signal,
    }),
    isAbortError,
  );

  assert.equal(controller.signal.aborted, true);
  assert.equal(client.callsWith(MAP_MARKER).length, 1);
  assert.equal(client.callsWith(REDUCE_MARKER).length, 0);
});

test("服务层：进度落库、最终 done，以及取消后保持 ready/cancelled", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "harness-literature-service-"));
  const config = loadConfig({
    HARNESS_DATA_DIR: join(tempRoot, "data"),
    HARNESS_MOCK_MODEL: "1",
    HARNESS_MODEL: "test-model",
    HARNESS_WORKSPACE: join(tempRoot, "workspace"),
  });
  const database = new HarnessDatabase(join(config.dataDir, "harness.sqlite"));
  const errors: string[] = [];
  const warnings: string[] = [];
  const client = new ScriptedModelClient(async (request) => {
    await delayUnlessAborted(300, request.signal);
    return reportJson("服务层测试报告");
  });
  const service = new LiteratureService({
    config,
    database,
    logger: {
      error: (_details, message) => errors.push(message),
      warn: (_details, message) => warnings.push(message),
    },
    modelClient: client,
  });

  const seed = async (id: string): Promise<void> => {
    const directory = join(config.literatureDir, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, "text.json"),
      JSON.stringify({ pages: ["第一页正文", "第二页正文"] }),
      "utf8",
    );
    database.createLiterature({
      charCount: 16,
      fileName: `${id}.pdf`,
      id,
      pageCount: 2,
      title: id,
    });
  };

  try {
    await service.initialize();
    await seed("doc-done");

    const started = service.analyze("doc-done");
    assert.equal(started.status, "analyzing");
    assert.equal(started.stage, "reading");

    const snapshots: Array<Pick<LiteratureRecord, "chunkCount" | "progress" | "stage">> = [];
    const done = await waitFor("文献分析完成", () => {
      const record = database.getLiterature("doc-done");
      if (record === null) return undefined;
      snapshots.push({
        chunkCount: record.chunkCount,
        progress: record.progress,
        stage: record.stage,
      });
      return record.status === "done" ? record : undefined;
    });

    assert.equal(done.status, "done");
    assert.equal(done.stage, "done");
    assert.equal(done.progress, 100);
    assert.equal(done.chunkCount, 1);
    assert.ok(done.reportJson !== null);
    const parsed = JSON.parse(done.reportJson) as { title?: unknown };
    assert.equal(parsed.title, "服务层测试报告");
    assert.ok(snapshots.some((snapshot) => snapshot.stage === "analyzing"));
    assert.ok(
      snapshots.some(
        (snapshot) =>
          snapshot.progress !== null && snapshot.progress > 0 && snapshot.progress < 100,
      ),
    );
    assert.ok(snapshots.some((snapshot) => snapshot.chunkCount === 1));
    assert.deepEqual(errors, []);

    // 分析进行中取消：应停在 cancelled，且不再写回 done。
    await seed("doc-cancel-started");
    service.analyze("doc-cancel-started");
    await waitFor("分析进入 analyzing", () => {
      const record = database.getLiterature("doc-cancel-started");
      return record !== null && record.stage === "analyzing" && (record.progress ?? 0) >= 25
        ? record
        : undefined;
    });
    const cancelled = service.cancel("doc-cancel-started");
    assert.equal(cancelled.status, "ready");
    assert.equal(cancelled.stage, "cancelled");
    assert.equal(cancelled.progress, null);
    await delay(400);
    const cancelFinal = database.getLiterature("doc-cancel-started");
    assert.ok(cancelFinal !== null);
    assert.equal(cancelFinal.status, "ready");
    assert.equal(cancelFinal.stage, "cancelled");
    assert.equal(cancelFinal.progress, null);
    assert.equal(cancelFinal.reportJson, null);

    // analyze 后立即取消：至少必须保持 ready，绝不能被写成 done。
    await seed("doc-cancel-immediate");
    service.analyze("doc-cancel-immediate");
    const immediate = service.cancel("doc-cancel-immediate");
    assert.equal(immediate.status, "ready");
    assert.equal(immediate.stage, "cancelled");
    assert.equal(immediate.progress, null);
    await delay(400);
    const immediateFinal = database.getLiterature("doc-cancel-immediate");
    assert.ok(immediateFinal !== null);
    assert.equal(immediateFinal.status, "ready");
    assert.notEqual(immediateFinal.stage, "done");
    assert.notEqual(immediateFinal.progress, 100);
    assert.equal(immediateFinal.reportJson, null);
    assert.deepEqual(errors, []);
  } finally {
    database.close();
    await rm(tempRoot, { force: true, recursive: true });
  }
});
