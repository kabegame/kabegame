import { BehaviorSubject, Observable, ReplaySubject, Subject, Subscription, map } from "rxjs";
import { pathqlCount, pathqlFetch } from "@/services/pathql";
import { batchWindow } from "./batchWindow";
import { PATHQL_REFRESH_WAIT_MS } from "./constants";
import { triggers$, type EventTrigger } from "./events";

export type PathqlKind = "rows" | "total";

/** `seq` 是请求服务按路径分配的请求序号，只用于判断结果新旧，与后端事件序号无关。 */
export interface PathqlRows {
  rows: Record<string, unknown>[];
  seq: number;
}

export interface PathqlTotal {
  total: number;
  seq: number;
}

export type SnapshotOf<K extends PathqlKind> = K extends "rows" ? PathqlRows : PathqlTotal;

/** 最新一次请求的状态：loading 与 error 都属于它，`seq` 不一定等于数据对应的请求序号。 */
export interface PathqlStatus {
  seq: number;
  loading: boolean;
  error: unknown | null;
}

/** 观察方从核心收到的信号：最后可得的数据、最新请求的状态。 */
export type LookerSignal<S> = { type: "data"; snapshot: S } | { type: "status"; status: PathqlStatus };

export type PathqlRequest = readonly [kind: PathqlKind, path: string];

/**
 * 唯一请求入口：next 一个请求即返回，不等待、不交还结果；结果与错误只经观察方看到。
 * 主动请求的通路只有两条：核心的事件窗口，与发起方的用户操作。
 */
export const pathqlRequest$ = new Subject<PathqlRequest>();

const readers: { [K in PathqlKind]: (path: string, seq: number) => Promise<SnapshotOf<K>> } = {
  rows: async (path, seq) => ({ rows: await pathqlFetch(path), seq }),
  total: async (path, seq) => ({ total: (await pathqlCount(path)).total, seq }),
};

interface Entry<S> {
  /** 已发出的最大请求序号，即最新请求。 */
  requested: number;
  /** 已返回的最大请求序号；pending 窗口是 (acked, requested]。 */
  acked: number;
  /** 最后可得的数据：新观察方先拿到它。 */
  data$: ReplaySubject<S>;
  /** 最新请求的状态。 */
  status$: BehaviorSubject<PathqlStatus>;
  /** 观察方的过滤器投票：窗口内任一同意就刷新一次。 */
  votes$: Subject<void>;
  refresh: Subscription;
  refs: number;
}

// 值的快照类型由 key 中的 kind 决定，读取时按 kind 还原
const entries = new Map<string, unknown>();

function entryId(kind: PathqlKind, path: string) {
  return `${kind}:${path}`;
}

function acquire<K extends PathqlKind>(kind: K, path: string): Entry<SnapshotOf<K>> {
  const id = entryId(kind, path);
  let entry = entries.get(id) as Entry<SnapshotOf<K>> | undefined;
  if (!entry) {
    const votes$ = new Subject<void>();
    entry = {
      requested: 0,
      acked: 0,
      data$: new ReplaySubject(1),
      status$: new BehaviorSubject<PathqlStatus>({ seq: 0, loading: false, error: null }),
      votes$,
      // 每个路径一个统一窗口：空闲时首票立即刷新，窗口内的票合并到窗口结束再刷新一次
      refresh: votes$
        .pipe(batchWindow(PATHQL_REFRESH_WAIT_MS, () => true))
        .subscribe(() => pathqlRequest$.next([kind, path])),
      refs: 0,
    };
    entries.set(id, entry);
  }
  entry.refs++;
  return entry;
}

// 没有观察方也没有在途请求时回收，避免把已离开路径的旧数据重放给后来者。
function release(kind: PathqlKind, path: string, entry: { refs: number; refresh: Subscription }) {
  entry.refs--;
  const id = entryId(kind, path);
  if (entry.refs <= 0 && entries.get(id) === entry) {
    entries.delete(id);
    entry.refresh.unsubscribe();
  }
}

/**
 * 返回时按累计确认处理：序号不大于已返回最大序号的，说明已被更晚的返回取消，静默丢弃；
 * 否则它确认并取消之前的全部 pending。成功即更新数据；loading / error 只随最新请求变化。
 */
function settle<S>(entry: Entry<S>, seq: number, result: { snapshot: S } | { error: unknown }) {
  if (seq <= entry.acked) return;
  entry.acked = seq;
  if ("snapshot" in result) entry.data$.next(result.snapshot);
  if (seq === entry.requested) {
    entry.status$.next({ seq, loading: false, error: "error" in result ? result.error : null });
  }
}

pathqlRequest$.subscribe(([kind, path]) => {
  const entry = acquire(kind, path);
  const seq = ++entry.requested;
  entry.status$.next({ seq, loading: true, error: null });
  void readers[kind](path, seq)
    .then(
      (snapshot) => settle(entry, seq, { snapshot }),
      (error) => settle(entry, seq, { error }),
    )
    .finally(() => release(kind, path, entry));
});

/**
 * 以观察方身份注册到某路径：只看最后可得的数据与最新请求的状态，不发请求。
 * `refreshOn` 是观察方的过滤器，订阅期间注册到核心；同一路径所有观察方的过滤器共用一个刷新窗口，
 * 窗口内任一过滤器同意就刷新一次，结果推给该路径的全部观察方。
 */
export function lookPathql<K extends PathqlKind>(
  kind: K,
  path: string,
  refreshOn: readonly EventTrigger[],
): Observable<LookerSignal<SnapshotOf<K>>> {
  return new Observable<LookerSignal<SnapshotOf<K>>>((subscriber) => {
    const entry = acquire(kind, path);
    const subscription = new Subscription();
    subscription.add(entry.data$.subscribe((snapshot) => subscriber.next({ type: "data", snapshot })));
    subscription.add(
      entry.status$
        .pipe(map((status) => ({ type: "status", status }) as const))
        .subscribe((signal) => subscriber.next(signal)),
    );
    subscription.add(triggers$(refreshOn).subscribe(() => entry.votes$.next()));
    return () => {
      subscription.unsubscribe();
      release(kind, path, entry);
    };
  });
}
