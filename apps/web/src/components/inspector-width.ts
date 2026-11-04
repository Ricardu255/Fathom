export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
export const INSPECTOR_DEFAULT_WIDTH = 380;
/** 主区域至少要留下的宽度，否则对话被挤得没法看。 */
const MAIN_AREA_MIN_WIDTH = 360;

/**
 * 侧栏宽度同时受三个条件约束：自身上下限、视口大小、以及主区域的最低宽度。
 * 窗口变窄时先压缩侧栏，而不是把对话区挤没。
 */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const available = Math.max(INSPECTOR_MIN_WIDTH, viewportWidth - MAIN_AREA_MIN_WIDTH);
  const upper = Math.min(INSPECTOR_MAX_WIDTH, available);
  if (!Number.isFinite(width)) return Math.min(INSPECTOR_DEFAULT_WIDTH, upper);
  return Math.round(Math.min(Math.max(width, INSPECTOR_MIN_WIDTH), upper));
}

/** 拖动分隔条时按「指针相对起点的位移」换算宽度：往左拖变宽。 */
export function widthFromDrag(input: {
  deltaX: number;
  startWidth: number;
  viewportWidth: number;
}): number {
  return clampInspectorWidth(input.startWidth - input.deltaX, input.viewportWidth);
}
