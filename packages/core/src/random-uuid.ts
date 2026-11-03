/**
 * 浏览器与 Node 24 都提供 Web Crypto；不要从 node:crypto 导入，
 * 否则 @harness/core 的根入口被打进 Web 包时会被 Vite externalize。
 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
