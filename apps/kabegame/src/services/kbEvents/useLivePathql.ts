import { onScopeDispose, ref, watch } from "vue";
import { BehaviorSubject, EMPTY, Subscription, distinctUntilChanged, map, of, switchMap, type Observable } from "rxjs";
import { batchWindow } from "./batchWindow";
import { pathqlData$, pathqlLoading$, requestPathql, type PathqlKind, type SnapshotOf } from "./pathqlSource";

/**
 * 当前 key 的实时 rows / count。两种触发通道都经请求服务：
 * - 事件通道：`changes` 里相关变更的 seq，按 waitMs 防抖合并，可合并在途读取；
 * - 请求通道：`refetch`（首次加载、翻页、手动刷新、写后补读），总是新开读取。
 * 结果一律从 `pathqlData$` 落地给 `onResult`，同一路径的快照 seq 不倒退。
 */
export function useLivePathql<K extends PathqlKind>(opts: {
  kind: K;
  key: () => string | null;
  /** 相关变更的 seq 流（见 `triggerSeq$`）。 */
  changes: Observable<number>;
  waitMs: number;
  /** key 与上次应用的不同，或标脏后重新激活时，自动请求（总数用；行由调用方显式请求）。 */
  autoFetch?: boolean;
  onResult: (snapshot: SnapshotOf<K>) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}) {
  const loading = ref(false);
  let appliedKey: string | null = null;
  let appliedSeq = 0;
  let dirty = false;
  let holds = 0;
  let heldSeq: number | null = null;

  const reportError = async (error: unknown) => {
    await opts.onError?.(error);
  };

  const key$ = new BehaviorSubject(opts.key());

  const stopKeySync = watch(opts.key, (key) => key$.next(key), { flush: "sync" });
  const currentKey$ = key$.pipe(distinctUntilChanged());

  const subscriptions = new Subscription();
  subscriptions.add(
    currentKey$
      .pipe(
        switchMap((key) =>
          key ? pathqlData$(opts.kind, key).pipe(map((snapshot) => [key, snapshot] as const)) : EMPTY,
        ),
      )
      .subscribe(([key, snapshot]) => {
        if (opts.key() !== key) return;
        appliedKey = key;
        appliedSeq = Math.max(appliedSeq, snapshot.seq);
        dirty = false;
        void Promise.resolve(opts.onResult(snapshot)).catch((error) => console.error("应用查询结果失败:", error));
      }),
  );
  subscriptions.add(
    currentKey$.pipe(switchMap((key) => (key ? pathqlLoading$(opts.kind, key) : of(false)))).subscribe((value) => {
      loading.value = value;
    }),
  );

  const onChange = (seq: number) => {
    if (holds > 0) {
      heldSeq = Math.max(heldSeq ?? 0, seq);
      return;
    }
    if (seq > 0 && seq <= appliedSeq) return;
    const key = opts.key();
    if (!key) {
      dirty = true;
      return;
    }
    void requestPathql(opts.kind, key, { minSeq: seq, join: true }).catch(reportError);
  };
  subscriptions.add(
    opts.changes
      .pipe(batchWindow(opts.waitMs, (seqs: number[]) => (seqs.includes(0) ? 0 : Math.max(...seqs))))
      .subscribe(onChange),
  );

  /** 请求通道：显式读取当前 key，不合并在途读取，错误抛给调用方。 */
  const refetch = async () => {
    const key = opts.key();
    if (!key) return;
    await requestPathql(opts.kind, key);
  };

  /**
   * 写操作期间暂存事件通道，写后补读落地再放行；放行时已被快照覆盖的序号直接跳过。
   * 返回的释放函数幂等，失败路径也必须调用。
   */
  const hold = () => {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--holds > 0) return;
      const seq = heldSeq;
      heldSeq = null;
      if (seq !== null) onChange(seq);
    };
  };

  watch(
    opts.key,
    (key, previous) => {
      if (!key) return;
      if (opts.autoFetch ? key !== appliedKey || dirty : !previous && dirty) {
        void refetch().catch(reportError);
      }
    },
    { immediate: opts.autoFetch },
  );
  onScopeDispose(() => {
    stopKeySync();
    subscriptions.unsubscribe();
  });

  return { loading, refetch, hold, key: opts.key };
}
