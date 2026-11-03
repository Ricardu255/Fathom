import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WorkspaceService, WorkspaceServiceError } from "../src/services/workspace-service";

let root = "";
let service: WorkspaceService;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-workspace-service-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");
  service = new WorkspaceService({ protectedPaths: [join(root, ".data")] });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("读取、写入与列表使用 workspace 相对路径", async () => {
  const read = await service.read(root, "src/index.ts");
  assert.equal(read.path, "src/index.ts");
  assert.match(read.content, /value = 1/u);

  const written = await service.write(root, "src/new.ts", "export const next = 2;\n");
  assert.equal(written.content, "export const next = 2;\n");
  const direct = await service.read(root, "src/new.ts");
  assert.equal(direct.content, "export const next = 2;\n");

  const listed = await service.list(root, "src", 2);
  assert.ok(listed.entries.some((entry) => entry.path === "src/new.ts"));
});

test("拒绝越界、二进制与超大文件", async () => {
  await assert.rejects(
    service.read(root, "../outside.txt"),
    (error: unknown) => error instanceof WorkspaceServiceError,
  );
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(
    service.read(root, "binary.bin"),
    (error: unknown) => error instanceof WorkspaceServiceError,
  );
  await writeFile(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(
    service.read(root, "large.txt"),
    (error: unknown) => error instanceof WorkspaceServiceError && error.code === "TOO_LARGE",
  );
  await assert.rejects(
    service.write(root, "too-large.txt", "x".repeat(1024 * 1024 + 1)),
    (error: unknown) => error instanceof WorkspaceServiceError && error.code === "TOO_LARGE",
  );
});
