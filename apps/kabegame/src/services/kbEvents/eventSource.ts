import { Observable, share } from "rxjs";
import { listen } from "@/api";

/** 一条后端事件：事件名、全局变更序号（payload 未携带时为 0）与原始 payload。 */
export interface KbEvent<T = unknown> {
  name: string;
  seq: number;
  payload: T;
}

const streams = new Map<string, Observable<KbEvent<unknown>>>();

/**
 * 后端事件的唯一入口（Tauri 事件或 Web SSE，由 `listen` 分流）。
 * 同名事件只注册一次监听、所有订阅者共享，最后一个订阅者退订后释放；核心不解析事件内容。
 */
export function kbEvent$<T = unknown>(name: string): Observable<KbEvent<T>> {
  let stream = streams.get(name);
  if (!stream) {
    stream = new Observable<KbEvent<unknown>>((subscriber) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      listen<unknown>(name, (event) => {
        const payload = event?.payload ?? {};
        const seq = Number((payload as { seq?: unknown }).seq);
        subscriber.next({ name, seq: Number.isFinite(seq) && seq > 0 ? seq : 0, payload });
      })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch((error) => console.error(`监听 ${name} 失败:`, error));
      return () => {
        disposed = true;
        unlisten?.();
      };
    }).pipe(share());
    streams.set(name, stream);
  }
  return stream as Observable<KbEvent<T>>;
}
