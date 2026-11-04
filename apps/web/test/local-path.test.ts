import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLocalPathRef } from "../src/components/local-path";

test("绝对路径与带扩展名的相对路径被识别为文件", () => {
  assert.deepEqual(parseLocalPathRef("src/app.ts"), { kind: "file", path: "src/app.ts" });
  assert.deepEqual(parseLocalPathRef("./docs/plan.md"), { kind: "file", path: "./docs/plan.md" });
  assert.deepEqual(parseLocalPathRef("D:\\code\\fathom\\README.md"), {
    kind: "file",
    path: "D:\\code\\fathom\\README.md",
  });
  assert.deepEqual(parseLocalPathRef("/etc/hosts"), { kind: "file", path: "/etc/hosts" });
});

test("图片扩展名标记为 image", () => {
  assert.equal(parseLocalPathRef("assets/home.png")?.kind, "image");
  assert.equal(parseLocalPathRef("./shot.JPG")?.kind, "image");
});

test("URL 与带 scheme 的文本不算本地路径", () => {
  assert.equal(parseLocalPathRef("https://example.com/a.png"), null);
  assert.equal(parseLocalPathRef("mailto:a@b.c"), null);
  assert.equal(parseLocalPathRef("npm:foo"), null);
});

test("命令与普通句子不会被误判", () => {
  assert.equal(parseLocalPathRef("npm run build"), null);
  assert.equal(parseLocalPathRef("pnpm typecheck && pnpm test"), null);
  assert.equal(parseLocalPathRef("这是一个普通句子"), null);
  assert.equal(parseLocalPathRef("@types/node"), null);
  assert.equal(parseLocalPathRef("README"), null);
});

test("空值与超长输入直接拒绝", () => {
  assert.equal(parseLocalPathRef(""), null);
  assert.equal(parseLocalPathRef("   "), null);
  assert.equal(parseLocalPathRef(`a/${"b".repeat(500)}.ts`), null);
});
