import { onBeforeUnmount, onMounted, watch } from "vue";
import { subscribeChanges, type ChangeBatch } from "@/services/dataChangeHub";
import { pathqlView } from "@/services/pathql";
import { sendDebugEvent } from "@kabegame/core/debugIngest"; // DEBUG-PERF
const perf = (name: string, payload: unknown) => void sendDebugEvent(name, payload, { sessionId: "eventworker-perf" }); // DEBUG-PERF

export const GRID_REFRESH_WAIT_MS = 500;

export interface ViewQuery {
  rows: string;
  count: string;
}

export interface ViewSnapshot {
  rows: Record<string, unknown>[];
  total: number;
  seq: number;
}

const inFlight = new Map<string, Promise<ViewSnapshot>>();

function queryKey(query: ViewQuery) {
  return JSON.stringify([query.rows, query.count]);
}

function fetchView(query: ViewQuery): Promise<ViewSnapshot> {
  const key = queryKey(query);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = pathqlView(query).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

export function useLiveQuery(opts: {
  key: () => ViewQuery | null;
  waitMs: number;
  relevant: (batch: ChangeBatch) => boolean;
  onResult: (snapshot: ViewSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
}) {
  let appliedSeq = 0;
  let dirty = false;

  const apply = async (snapshot: ViewSnapshot) => {
    if (snapshot.seq < appliedSeq) return;
    appliedSeq = snapshot.seq;
    await opts.onResult(snapshot);
  };

  /**
   * 拉取并应用当前视图；错误向上抛。
   * shared：是否合并同 key 的在途请求（仅被动批次合并）。
   * minSeq：批次已知的最新变更序号。合并到的在途请求若早于它发出（快照 seq 更旧），
   * 绕过合并单独重拉，避免把该变更漏掉。
   */
  const fetchAndApply = async (shared: boolean, minSeq = 0) => {
    const query = opts.key();
    if (!query) return;
    const key = queryKey(query);
    const t0 = performance.now(); // DEBUG-PERF
    let snapshot = shared ? await fetchView(query) : await pathqlView(query);
    const t1 = performance.now(); // DEBUG-PERF
    let refetched = false; // DEBUG-PERF
    if (snapshot.seq < minSeq) {
      snapshot = await pathqlView(query);
      refetched = true;
    } // DEBUG-PERF 仅加了 refetched 标记
    const t2 = performance.now(); // DEBUG-PERF
    const current = opts.key();
    if (!current || queryKey(current) !== key) {
      perf("lq_drop_key_changed", { rows: query.rows });
      return;
    } // DEBUG-PERF 仅加了埋点
    dirty = false;
    const prevApplied = appliedSeq; // DEBUG-PERF
    await apply(snapshot);
    perf("lq_fetch", {
      rows: query.rows,
      shared,
      minSeq,
      seq: snapshot.seq,
      prevApplied,
      dropped: snapshot.seq < prevApplied,
      refetched,
      n: snapshot.rows.length,
      total: snapshot.total,
      ipcMs: +(t1 - t0).toFixed(1),
      refetchMs: +(t2 - t1).toFixed(1),
      applyMs: +(performance.now() - t2).toFixed(1),
    }); // DEBUG-PERF
  };

  /** 显式拉取（首次加载、翻页、手动刷新）：不合并在途请求，错误抛给调用方。 */
  const refetch = () => fetchAndApply(false);

  let unsubscribe: (() => void) | null = null;
  onMounted(() => {
    unsubscribe = subscribeChanges({
      waitMs: opts.waitMs,
      filter: opts.relevant,
      onBatch: async (batch) => {
        perf("lq_batch", {
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
          opts.onError?.(error);
        }
      },
    });
  });

  watch(opts.key, (query, previous) => {
    if (query && !previous && dirty) void refetch().catch((error) => opts.onError?.(error));
  });
  onBeforeUnmount(() => unsubscribe?.());

  return {
    refetch,
    apply,
    view: opts.key,
  };
}
