import { type HarnessEvent, HarnessEventType, type TextDeltaData } from "@harness/core/events";
import { useEffect } from "react";
import { useChatStore } from "../../stores/chat-store";

const EVENT_TYPES = Object.values(HarnessEventType);
const RECONNECT_DELAY_MS = 1_500;

/**
 * 只订阅当前可见 Session。文本增量按动画帧合并，避免每个 token 触发一次全局重渲染。
 * 重连从 lastSeq 继续，服务端会重放持久化事件和有限的 transient 缓冲。
 */
export function useSessionStream(sessionId: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let closed = false;
    let reconnectTimer: number | undefined;
    let frame: number | undefined;
    let buffer = "";
    let bufferSeq = 0;

    const flush = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      if (buffer === "") return;
      const text = buffer;
      const seq = bufferSeq;
      buffer = "";
      useChatStore.getState().appendDelta(text, seq);
    };

    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (buffer === "") return;
        const text = buffer;
        const seq = bufferSeq;
        buffer = "";
        useChatStore.getState().appendDelta(text, seq);
      });
    };

    const handle = (event: HarnessEvent) => {
      if (event.sessionId !== sessionId) return;
      if (event.seq <= useChatStore.getState().lastSeq) return;
      if (event.type === HarnessEventType.TEXT_DELTA) {
        buffer += (event.data as TextDeltaData).text;
        bufferSeq = event.seq;
        schedule();
        return;
      }
      flush();
      useChatStore.getState().applyEvent(event);
    };

    const connect = () => {
      if (closed) return;
      const afterSeq = useChatStore.getState().lastSeq;
      const next = new EventSource(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=${afterSeq}`,
      );
      source = next;
      for (const type of EVENT_TYPES) {
        next.addEventListener(type, (message) => {
          try {
            const event = JSON.parse((message as MessageEvent).data as string) as HarnessEvent;
            handle(event);
          } catch {
            // 忽略无法解析的帧；下一条事件仍会继续处理。
          }
        });
      }
      next.onerror = () => {
        if (closed) return;
        next.close();
        if (source === next) source = null;
        if (reconnectTimer === undefined) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = undefined;
            connect();
          }, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      flush();
    };
  }, [sessionId, enabled]);
}
