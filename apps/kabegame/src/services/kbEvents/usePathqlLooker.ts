import { onScopeDispose, ref, shallowRef, watch } from "vue";
import { BehaviorSubject, distinctUntilChanged, map, of, switchMap } from "rxjs";
import type { EventTrigger } from "./events";
import { lookPathql, type LookerSignal, type PathqlKind, type SnapshotOf } from "./pathqlSource";

/**
 * 当前 key 的观察方：只看该 key 最后可得的数据与最新请求的状态，不发请求。
 * `refreshOn` 是本观察方的过滤器，随 key 注册到 pathql 核心；刷新窗口与请求都由核心处理。
 * 用户操作要刷新时由调用方 `pathqlRequest$.next([kind, key])`。
 */
export function usePathqlLooker<K extends PathqlKind>(opts: {
  kind: K;
  key: () => string | null;
  refreshOn: readonly EventTrigger[];
  onResult: (snapshot: SnapshotOf<K>) => void | Promise<void>;
  /** 最新请求失败时通知；更早请求的失败看不到。 */
  onError?: (error: unknown) => void | Promise<void>;
}) {
  const loading = ref(false);
  const error = shallowRef<unknown | null>(null);

  const key$ = new BehaviorSubject(opts.key());
  const stopKeySync = watch(opts.key, (key) => key$.next(key), { flush: "sync" });

  const subscription = key$
    .pipe(
      distinctUntilChanged(),
      switchMap((key) =>
        key ? lookPathql(opts.kind, key, opts.refreshOn).pipe(map((signal) => [key, signal] as const)) : of(null),
      ),
    )
    .subscribe((item) => {
      if (!item) {
        loading.value = false;
        error.value = null;
        return;
      }
      const [key, signal] = item as readonly [string, LookerSignal<SnapshotOf<K>>];
      if (opts.key() !== key) return;
      if (signal.type === "status") {
        loading.value = signal.status.loading;
        error.value = signal.status.error;
        if (signal.status.error != null) void Promise.resolve(opts.onError?.(signal.status.error));
      } else {
        void Promise.resolve(opts.onResult(signal.snapshot)).catch((e) => console.error("应用查询结果失败:", e));
      }
    });

  onScopeDispose(() => {
    stopKeySync();
    subscription.unsubscribe();
  });

  return { loading, error };
}
