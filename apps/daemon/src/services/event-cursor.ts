const EVENT_ID_PATTERN = /^\d+$/u;

/**
 * SSE 断线重连时浏览器会带 Last-Event-ID，但首次连接没有它；
 * 查询参数优先，便于客户端显式指定从哪里开始重放。
 *
 * 返回 -1 表示游标非法，由调用方决定怎么回复。
 */
export function resolveEventCursor(input: {
  afterSeq?: string | undefined;
  lastEventId?: string | undefined;
}): number {
  const raw = input.afterSeq ?? input.lastEventId;
  if (raw === undefined || raw === "") return 0;
  if (!EVENT_ID_PATTERN.test(raw)) return -1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}
