import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createViewImageTool, detectImage } from "../src/view-image";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "fathom-view-image-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

test("view_image 返回图片内容与尺寸", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "pixel.png"), PNG_1X1);
    const tool = createViewImageTool({ supportsImages: () => true });
    const result = await tool.execute(
      { path: "pixel.png" },
      { signal: new AbortController().signal, workspaceRoot: workspace },
    );
    assert.equal(result.images?.length, 1);
    assert.equal(result.images?.[0]?.mimeType, "image/png");
    assert.match(result.content, /1x1/u);
  });
});

test("模型不支持图片时拒绝，且越界路径被拒绝", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "pixel.png"), PNG_1X1);
    const disabled = createViewImageTool({ supportsImages: () => false });
    const result = await disabled.execute(
      { path: "pixel.png" },
      { signal: new AbortController().signal, workspaceRoot: workspace },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /不支持图片/u);

    const enabled = createViewImageTool({ supportsImages: () => true });
    await assert.rejects(() =>
      enabled.execute(
        { path: "../outside.png" },
        { signal: new AbortController().signal, workspaceRoot: workspace },
      ),
    );
  });
});

test("图片格式与边长限制", async () => {
  const header = Buffer.alloc(33);
  PNG_1X1.copy(header, 0, 0, 8);
  header.writeUInt32BE(5_000, 16);
  header.writeUInt32BE(1, 20);
  assert.deepEqual(detectImage(header), { height: 1, mimeType: "image/png", width: 5_000 });
  assert.equal(detectImage(Buffer.from("not an image")), null);

  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, "big.png"), header);
    const tool = createViewImageTool({ supportsImages: () => true });
    const result = await tool.execute(
      { path: "big.png" },
      { signal: new AbortController().signal, workspaceRoot: workspace },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /边长限制/u);
  });
});
