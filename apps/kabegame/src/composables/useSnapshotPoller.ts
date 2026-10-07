import { readonly, ref, type Ref } from "vue";
import { listen, type UnlistenFn } from "@/api/rpc";

export interface SnapshotPollerOptions<T> {
  /** 单例键：同 key 多处调用共享一个轮询器。 */
  key: string;
  fetch: () => Promise<T>;
  apply: (snapshot: T) => void;
  /** 返回 true 则在 intervalMs 后继续拉；false 则停下等待唤醒。 */
  isActive: (snapshot: T) => boolean;
  /** 收到任一事件即 wake()。 */
  wakeEvents: string[];
  intervalMs?: number;
}

export interface SnapshotPoller {
  /** 注册唤醒事件并立即拉一次。 */
  start(): Promise<void>;
  /** 立即拉一次；有请求在途时只登记一次补拉。 */
  wake(): void;
  /** 作废在途响应并立即补拉。 */
  invalidate(): void;
  polling: Readonly<Ref<boolean>>;
  dispose(): void;
}

const pollers = new Map<string, SnapshotPoller>();

export function useSnapshotPoller<T>(options: SnapshotPollerOptions<T>): SnapshotPoller {
  const existing = pollers.get(options.key);
  if (existing) return existing;

  const polling = ref(false);
  const intervalMs = options.intervalMs ?? 500;
  const unlisteners: UnlistenFn[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let inFlight = false;
  let pendingWake = false;
  let disposed = false;
  let started = false;
  let startPromise: Promise<void> | null = null;

  const clearTimer = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clearTimer();
    if (disposed) return;
    polling.value = true;
    timer = setTimeout(() => {
      timer = null;
      void pull();
    }, intervalMs);
  };

  const pull = async (): Promise<void> => {
    if (disposed) return;
    clearTimer();
    if (inFlight) {
      pendingWake = true;
      return;
    }

    inFlight = true;
    const requestGeneration = generation;
    let active = false;
    try {
      const snapshot = await options.fetch();
      if (disposed || requestGeneration !== generation) return;
      options.apply(snapshot);
      active = options.isActive(snapshot);
    } catch (error) {
      console.error(`[snapshot-poller:${options.key}] fetch failed:`, error);
      // 轮询中的瞬时失败不停表，避免卡片停在旧进度；首拉失败则等下一次唤醒
      active = polling.value;
    } finally {
      inFlight = false;
      if (disposed) return;
      if (pendingWake) {
        pendingWake = false;
        void pull();
      } else if (requestGeneration === generation && active) {
        schedule();
      } else {
        polling.value = false;
      }
    }
  };

  const poller: SnapshotPoller = {
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (!started) {
          started = true;
          for (const eventName of options.wakeEvents) {
            const unlisten = await listen(eventName, () => poller.wake());
            if (disposed) unlisten();
            else unlisteners.push(unlisten);
          }
        }
        await pull();
      })();
      return startPromise;
    },
    wake() {
      if (disposed) return;
      // 已在 0.5s 周期内：下一拍自然会拉到最新快照，不额外加拉，保持统一节奏
      if (timer != null) return;
      if (inFlight) {
        pendingWake = true;
        return;
      }
      void pull();
    },
    invalidate() {
      if (disposed) return;
      generation += 1;
      poller.wake();
    },
    polling: readonly(polling),
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      pendingWake = false;
      polling.value = false;
      clearTimer();
      for (const unlisten of unlisteners.splice(0)) unlisten();
      if (pollers.get(options.key) === poller) pollers.delete(options.key);
    },
  };

  pollers.set(options.key, poller);
  return poller;
}
