import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileTool, writeFileTool } from "@harness/tools";
import { executionModeForTool, toPiAnnotations } from "../src/pi/tools";

test("声明为只读的工具即使不在白名单里也可以并行", () => {
  assert.equal(
    executionModeForTool({ annotations: { readOnly: true }, name: "custom_reader" }),
    "parallel",
  );
});

test("没有声明也没进白名单的工具保持串行", () => {
  assert.equal(executionModeForTool({ name: "custom_writer" }), "sequential");
  assert.equal(
    executionModeForTool({ annotations: { destructive: true }, name: "custom_writer" }),
    "sequential",
  );
});

test("白名单里的只读工具没有 annotation 时仍然并行", () => {
  assert.equal(executionModeForTool({ name: "read_file" }), "parallel");
});

test("annotation 映射成 pi 的 Hint 命名", () => {
  assert.deepEqual(toPiAnnotations({ destructive: true, idempotent: false, readOnly: true }), {
    destructiveHint: true,
    idempotentHint: false,
    readOnlyHint: true,
  });
  assert.deepEqual(toPiAnnotations({ readOnly: true }), { readOnlyHint: true });
});

test("没有 annotation 或内容为空时不产生对象", () => {
  assert.equal(toPiAnnotations(undefined), undefined);
  assert.equal(toPiAnnotations({}), undefined);
});

test("真实工具带着各自的 annotation", () => {
  assert.equal(readFileTool.annotations?.readOnly, true);
  assert.equal(readFileTool.annotations?.idempotent, true);
  assert.equal(writeFileTool.annotations?.destructive, true);
});
