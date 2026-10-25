import { computed, onScopeDispose, shallowReactive, watch } from "vue";
import { Subscription } from "rxjs";
import type { EventTrigger } from "./events";
import { lookPathql, type PathqlKind, type SnapshotOf } from "./pathqlSource";

interface KeyStatus {
  loading: boolean;
  error: unknown | null;
}

/**
 * 一组动态 key 的观察方：key 列表增删时逐个注册 / 退订，只看各 key 最后可得的数据与最新请求的状态，不发请求。
 * 适合懒加载的分支（展开一层多一个 key），每个 key 是独立的数据源与刷新窗口，加入新 key 不影响已有 key。
 * `refreshOn` 可按 key 给出各自的过滤器；all 的 key 用 `pathqlAllKey(queries)` 生成。
 * 新加入的 key 由调用方 `pathqlRequest$.next([kind, key])` 请求（展开是用户操作）；已有数据的 key 加入时直接拿到它。
 */
export function usePathqlLookMany<K extends PathqlKind>(opts: {
  kind: K;
  keys: () => readonly string[];
  refreshOn: readonly EventTrigger[] | ((key: string) => readonly EventTrigger[]);
  onResult: (key: string, snapshot: SnapshotOf<K>) => void | Promise<void>;
  /** 某 key 的最新请求失败时通知；更早请求的失败看不到。 */
  onError?: (key: string, error: unknown) => void | Promise<void>;
}) {
  const statuses = shallowReactive(new Map<string, KeyStatus>());
  const lookers = new Map<string, Subscription>();

  const triggersOf = (key: string) => (typeof opts.refreshOn === "function" ? opts.refreshOn(key) : opts.refreshOn);

  const unlook = (key: string) => {
    lookers.get(key)?.unsubscribe();
    lookers.delete(key);
    statuses.delete(key);
  };

  const sync = (keys: readonly string[]) => {
    const next = new Set(keys.filter(Boolean));
    for (const key of [...lookers.keys()]) {
      if (!next.has(key)) unlook(key);
    }
    for (const key of next) {
      if (lookers.has(key)) continue;
      // 先登记再订阅：已有数据会同步重放，回调里要能认出自己
      const subscription = new Subscription();
      lookers.set(key, subscription);
      subscription.add(
        lookPathql(opts.kind, key, triggersOf(key)).subscribe((signal) => {
          if (lookers.get(key) !== subscription) return;
          if (signal.type === "status") {
            statuses.set(key, { loading: signal.status.loading, error: signal.status.error });
            if (signal.status.error != null) void Promise.resolve(opts.onError?.(key, signal.status.error));
          } else {
            void Promise.resolve(opts.onResult(key, signal.snapshot)).catch((e) =>
              console.error("应用查询结果失败:", key, e),
            );
          }
        }),
      );
    }
  };

  const stopKeySync = watch(opts.keys, sync, { immediate: true, flush: "sync" });

  onScopeDispose(() => {
    stopKeySync();
    for (const key of [...lookers.keys()]) unlook(key);
  });

  return {
    loading: (key: string) => statuses.get(key)?.loading ?? false,
    error: (key: string) => statuses.get(key)?.error ?? null,
    /** 任一已注册 key 的最新请求在途。 */
    anyLoading: computed(() => [...statuses.values()].some((status) => status.loading)),
  };
}
