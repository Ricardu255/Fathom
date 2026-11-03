import { createHash, timingSafeEqual } from "node:crypto";

export const DESKTOP_TOKEN_HEADER = "x-fathom-desktop-token";

/**
 * 固定长度摘要后再比较：timingSafeEqual 要求两侧等长，先哈希既避免抛错，
 * 也不让比较耗时时长泄露 token 长度。
 */
export function matchesDesktopToken(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected === "" || provided === undefined) return false;
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
