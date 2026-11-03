/** 距离底部小于这个像素就认为用户还在跟着最新输出。 */
export const FOLLOW_THRESHOLD_PX = 96;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/**
 * 只有用户还在底部附近才自动跟随。否则新内容到达时不能抢走滚动位置——
 * 长会话里往回翻的时候被拽到底部是最烦人的体验之一。
 */
export function isNearBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}
