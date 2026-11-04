import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampInspectorWidth,
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  widthFromDrag,
} from "../src/components/inspector-width";

test("宽度被夹在自身上下限内", () => {
  assert.equal(clampInspectorWidth(100, 1920), INSPECTOR_MIN_WIDTH);
  assert.equal(clampInspectorWidth(5_000, 1920), INSPECTOR_MAX_WIDTH);
  assert.equal(clampInspectorWidth(420, 1920), 420);
});

test("窗口变窄时先压缩侧栏，给主区域留位置", () => {
  // 900 宽视口：主区域至少 360，侧栏最多 540。
  assert.equal(clampInspectorWidth(720, 900), 540);
  // 700 宽视口：最多 340。
  assert.equal(clampInspectorWidth(720, 700), 340);
  // 极窄视口：不低于最小宽度。
  assert.equal(clampInspectorWidth(720, 400), INSPECTOR_MIN_WIDTH);
});

test("非法宽度回落到默认值，且同样受视口约束", () => {
  assert.equal(clampInspectorWidth(Number.NaN, 1920), INSPECTOR_DEFAULT_WIDTH);
  assert.equal(clampInspectorWidth(Number.NaN, 500), 280);
});

test("向左拖动变宽，向右拖动变窄", () => {
  assert.equal(widthFromDrag({ deltaX: -80, startWidth: 400, viewportWidth: 1920 }), 480);
  assert.equal(widthFromDrag({ deltaX: 80, startWidth: 400, viewportWidth: 1920 }), 320);
  assert.equal(widthFromDrag({ deltaX: 900, startWidth: 400, viewportWidth: 1920 }), 280);
});
