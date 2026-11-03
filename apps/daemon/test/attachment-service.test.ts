import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { AttachmentService, AttachmentServiceError } from "../src/services/attachment-service";
import { HarnessDatabase } from "../src/storage/database";

let root = "";
let database: HarnessDatabase;
let service: AttachmentService;
const sessionId = "session-attachments";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-attachments-"));
  database = new HarnessDatabase(join(root, "harness.sqlite"));
  service = new AttachmentService(database);
});

after(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("文本附件上传、上下文注入与删除", async () => {
  const uploaded = await service.upload({
    buffer: Buffer.from("# 说明\n\n使用 pnpm 构建。\n"),
    fileName: "notes.md",
    sessionId,
  });
  assert.equal(uploaded.kind, "text");
  assert.equal(uploaded.fileName, "notes.md");
  assert.ok(uploaded.charCount > 0);
  assert.equal(service.list(sessionId).length, 1);

  const built = service.buildContext(sessionId, [uploaded.id]);
  assert.match(built.context, /notes\.md/u);
  assert.match(built.context, /pnpm/u);
  assert.deepEqual(
    built.attachments.map((item) => item.id),
    [uploaded.id],
  );

  service.delete(uploaded.id, sessionId);
  assert.equal(service.list(sessionId).length, 0);
  assert.throws(
    () => service.buildContext(sessionId, [uploaded.id]),
    (error: unknown) => error instanceof AttachmentServiceError && error.code === "NOT_FOUND",
  );
});

test("XLSX 会按工作表提取为文本", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["指标", "数值"],
    ["召回率", 0.92],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "结果");
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;

  const uploaded = await service.upload({
    buffer,
    fileName: "metrics.xlsx",
    sessionId,
  });
  assert.equal(uploaded.kind, "xlsx");
  const built = service.buildContext(sessionId, [uploaded.id]);
  assert.match(built.context, /Sheet: 结果/u);
  assert.match(built.context, /召回率/u);
  service.delete(uploaded.id, sessionId);
});

test("拒绝不支持的类型、空文件与错误 Session", async () => {
  await assert.rejects(
    service.upload({ buffer: Buffer.from("x"), fileName: "a.exe", sessionId }),
    (error: unknown) => error instanceof AttachmentServiceError && error.code === "UNSUPPORTED",
  );
  await assert.rejects(
    service.upload({ buffer: Buffer.alloc(0), fileName: "a.txt", sessionId }),
    (error: unknown) => error instanceof AttachmentServiceError && error.code === "INVALID",
  );
  const uploaded = await service.upload({
    buffer: Buffer.from("hello"),
    fileName: "a.txt",
    sessionId,
  });
  assert.throws(
    () => service.buildContext("another-session", [uploaded.id]),
    (error: unknown) => error instanceof AttachmentServiceError && error.code === "NOT_FOUND",
  );
  service.delete(uploaded.id, sessionId);
});

test("PPTX 会按幻灯片提取文本", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>研究背景</a:t></a:r></a:p></p:sld>");
  zip.file(
    "ppt/slides/slide2.xml",
    "<p:sld><a:p><a:r><a:t>方法 &amp; 结果</a:t></a:r></a:p></p:sld>",
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const uploaded = await service.upload({
    buffer,
    fileName: "slides.pptx",
    sessionId,
  });
  assert.equal(uploaded.kind, "pptx");
  const built = service.buildContext(sessionId, [uploaded.id]);
  assert.match(built.context, /Slide 1/u);
  assert.match(built.context, /研究背景/u);
  assert.match(built.context, /Slide 2/u);
  assert.match(built.context, /方法 & 结果/u);
  service.delete(uploaded.id, sessionId);
});
