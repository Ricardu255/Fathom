import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as XLSX from "xlsx";
import { createReadDocumentTool, createViewPdfPageTool } from "../src/pi/document-tools";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "fathom-doc-tools-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

const contextFor = (workspace: string) => ({
  signal: new AbortController().signal,
  workspaceRoot: workspace,
});

test("read_document 读取文本与 XLSX，并支持截断", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "note.md"), "# 标题\n\n正文内容", "utf8");
    const tool = createReadDocumentTool();
    const text = await tool.execute({ path: "note.md" }, contextFor(workspace));
    assert.match(text.content, /正文内容/u);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["name", "value"],
        ["alpha", 1],
      ]),
      "Sheet1",
    );
    await writeFile(
      join(workspace, "data.xlsx"),
      XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }),
    );
    const sheet = await tool.execute({ path: "data.xlsx" }, contextFor(workspace));
    assert.match(sheet.content, /Sheet1/u);
    assert.match(sheet.content, /alpha/u);

    const truncated = await tool.execute(
      { maxChars: 1_000, path: "note.md" },
      contextFor(workspace),
    );
    assert.match(truncated.content, /字符数/u);
  });
});

test("read_document 拒绝越界路径与不支持的扩展名", async () => {
  await withWorkspace(async (workspace) => {
    const tool = createReadDocumentTool();
    await assert.rejects(() => tool.execute({ path: "../outside.md" }, contextFor(workspace)));
    await writeFile(join(workspace, "file.bin"), Buffer.from([0, 1, 2]));
    await assert.rejects(() => tool.execute({ path: "file.bin" }, contextFor(workspace)));
  });
});

test("view_pdf_page 校验模型能力、PDF 签名与页码，并在缺少渲染器时给出提示", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "doc.pdf"), "%PDF-1.4\nfake");
    const disabled = createViewPdfPageTool({ supportsImages: () => false });
    const unsupported = await disabled.execute({ page: 1, path: "doc.pdf" }, contextFor(workspace));
    assert.equal(unsupported.isError, true);

    const tool = createViewPdfPageTool({ supportsImages: () => true });
    await writeFile(join(workspace, "not.pdf"), "plain text");
    const invalid = await tool.execute({ page: 1, path: "not.pdf" }, contextFor(workspace));
    assert.equal(invalid.isError, true);
    assert.match(invalid.content, /不是有效的 PDF/u);

    const failed = await tool.execute({ page: 1, path: "doc.pdf" }, contextFor(workspace));
    assert.equal(failed.isError, true);
    assert.match(failed.content, /渲染失败|napi-rs\/canvas/u);
  });
});
