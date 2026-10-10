import { computed, onBeforeUnmount, onMounted, reactive, watch } from "vue";
import { subscribeChanges, type ChangeBatch } from "@/services/dataChangeHub";
import { sendDebugEvent } from "@/debugIngest"; // DEBUG-PERF
const perf = (name: string, payload: unknown) => void sendDebugEvent(name, payload, { sessionId: "eventworker-perf" }); // DEBUG-PERF

export const GRID_REFRESH_WAIT_MS = 500;

export interface RowsSnapshot {
  rows: Record<string, unknown>[];
  seq: number;
}

export interface TotalSnapshot {
  total: number;
  seq: number;
}

type SequencedSnapshot = { seq: number };
type QueryKind = "rows" | "total";

const inFlight = new WeakMap<Function, Map<string, Promise<unknown>>>();

function fetchShared<S extends SequencedSnapshot>(read: (key: string) => Promise<S>, key: string): Promise<S> {
  let requests = inFlight.get(read);
  if (!requests) {
    requests = new Map();
    inFlight.set(read, requests);
  }
  const existing = requests.get(key) as Promise<S> | undefined;
  if (existing) return existing;
  const request = read(key).finally(() => {
    requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

function snapshotMetrics(snapshot: SequencedSnapshot) {
  const value = snapshot as Partial<RowsSnapshot & TotalSnapshot>;
  if (Array.isArray(value.rows)) return { kind: "rows" as const, n: value.rows.length };
  return { kind: "total" as const, total: value.total };
}

export function useLiveQuery<S extends SequencedSnapshot>(opts: {
  key: () => string | null;
  read: (key: string) => Promise<S>;
  waitMs: number;
  relevant: (batch: ChangeBatch) => boolean;
  onResult: (snapshot: S) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  /** key 与上次应用的 key 不同，或标脏后重新激活时，自动重读（总数用；行由调用方显式加载）。 */
  autoFetch?: boolean;
  /** 仅用于 DEBUG-PERF 区分单通道实例。 */
  kind?: QueryKind;
}) {
  let appliedSeq = 0;
  let appliedKey: string | null = null;
  let dirty = false;
  let observedKind: QueryKind | null = opts.kind ?? null;
  const pendingQueries = reactive(new Map<string, number>());
  /** 只统计当前查询的在途读取，旧路径的迟到请求不能改变新页的就绪状态。 */
  const loading = computed(() => {
    const key = opts.key();
    return !!key && (pendingQueries.get(key) ?? 0) > 0;
  });

  const applyForKey = async (snapshot: S, key: string) => {
    if (snapshot.seq < appliedSeq) return;
    appliedSeq = snapshot.seq;
    appliedKey = key;
    await opts.onResult(snapshot);
  };

  const apply = async (snapshot: S) => {
    const key = opts.key();
    if (!key) return;
    await applyForKey(snapshot, key);
  };

  /**
   * 拉取并应用当前单通道快照；错误向上抛。
   * shared：是否合并同读函数、同 key 的在途请求（仅被动批次合并）。
   * minSeq：批次已知的最新变更序号。合并到的在途请求若早于它发出（快照 seq 更旧），
   * 绕过合并单独重拉，避免把该变更漏掉。
   */
  const fetchAndApply = async (shared: boolean, minSeq = 0) => {
    const key = opts.key();
    if (!key) return;
    pendingQueries.set(key, (pendingQueries.get(key) ?? 0) + 1);
    try {
      const t0 = performance.now(); // DEBUG-PERF
      let snapshot = shared ? await fetchShared(opts.read, key) : await opts.read(key);
      const t1 = performance.now(); // DEBUG-PERF
      let refetched = false; // DEBUG-PERF
      if (snapshot.seq < minSeq) {
        snapshot = await opts.read(key);
        refetched = true;
      } // DEBUG-PERF 仅加了 refetched 标记
      const t2 = performance.now(); // DEBUG-PERF
      if (opts.key() !== key) {
        perf("lq_drop_key_changed", { kind: observedKind, key });
        return;
      } // DEBUG-PERF 仅加了埋点
      dirty = false;
      const prevApplied = appliedSeq; // DEBUG-PERF
      const metrics = snapshotMetrics(snapshot); // DEBUG-PERF
      observedKind = metrics.kind; // DEBUG-PERF
      await applyForKey(snapshot, key);
      perf("lq_fetch", {
        key,
        shared,
        minSeq,
        seq: snapshot.seq,
        prevApplied,
        dropped: snapshot.seq < prevApplied,
        refetched,
        ...metrics,
        ipcMs: +(t1 - t0).toFixed(1),
        refetchMs: +(t2 - t1).toFixed(1),
        applyMs: +(performance.now() - t2).toFixed(1),
      }); // DEBUG-PERF
    } finally {
      const remaining = (pendingQueries.get(key) ?? 1) - 1;
      if (remaining > 0) pendingQueries.set(key, remaining);
      else pendingQueries.delete(key);
    }
  };

  /** 显式拉取（首次加载、翻页、手动刷新）：不合并在途请求，错误抛给调用方。 */
  const refetch = () => fetchAndApply(false);

  const reportError = async (error: unknown) => {
    await opts.onError?.(error);
  };

  let unsubscribe: (() => void) | null = null;
  onMounted(() => {
    unsubscribe = subscribeChanges({
      waitMs: opts.waitMs,
      filter: opts.relevant,
      onBatch: async (batch) => {
        perf("lq_batch", {
          kind: observedKind,
          maxSeq: batch.maxSeq,
          appliedSeq,
          skip: batch.maxSeq <= appliedSeq,
          reasons: [...batch.images],
          nImageIds: batch.imageIds.size,
          active: !!opts.key(),
        }); // DEBUG-PERF
        if (batch.maxSeq <= appliedSeq) return;
        if (!opts.key()) {
          dirty = true;
          return;
        }
        try {
          await fetchAndApply(true, batch.maxSeq);
        } catch (error) {
          await reportError(error);
        }
      },
    });
  });

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
  onBeforeUnmount(() => unsubscribe?.());

  return {
    loading,
    refetch,
    apply,
    key: opts.key,
  };
}
