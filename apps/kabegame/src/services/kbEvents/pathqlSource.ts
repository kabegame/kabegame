import { BehaviorSubject, Observable, ReplaySubject, Subject, Subscription, distinctUntilChanged, map } from "rxjs";
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

/** 观察方从核心收到的信号：数据状态、在途状态、事件刷新失败。 */
export type LookerSignal<S> =
  { type: "data"; snapshot: S } | { type: "loading"; loading: boolean } | { type: "error"; error: unknown };

const readers: { [K in PathqlKind]: (path: string, seq: number) => Promise<SnapshotOf<K>> } = {
  rows: async (path, seq) => ({ rows: await pathqlFetch(path), seq }),
  total: async (path, seq) => ({ total: (await pathqlCount(path)).total, seq }),
};

interface Entry<S> {
  /** 已发出的最大请求序号。 */
  requested: number;
  /** 当前数据状态对应的请求序号；0 表示尚无数据。 */
  applied: number;
  /** rows / count 数据源：新观察方先拿到当前数据状态。 */
  data$: ReplaySubject<S>;
  pending$: BehaviorSubject<number>;
  /** 事件触发的刷新失败；用户请求的错误由调用方自己接。 */
  error$: Subject<unknown>;
  /** 观察方的过滤器投票：窗口内任一同意就刷新一次。 */
  votes$: Subject<void>;
  refresh: Subscription;
  refs: number;
}

// 值的快照类型由 key 中的 kind 决定，读取时按 kind 还原
const entries = new Map<string, unknown>();

function entryId(kind: PathqlKind, path: string) {
  return `${kind}\u0000${path}`;
}

function acquire<K extends PathqlKind>(kind: K, path: string): Entry<SnapshotOf<K>> {
  const id = entryId(kind, path);
  let entry = entries.get(id) as Entry<SnapshotOf<K>> | undefined;
  if (!entry) {
    const votes$ = new Subject<void>();
    const error$ = new Subject<unknown>();
    entry = {
      requested: 0,
      applied: 0,
      data$: new ReplaySubject(1),
      pending$: new BehaviorSubject(0),
      error$,
      votes$,
      // 每个路径一个统一窗口：空闲时首票立即刷新，窗口内的票合并到窗口结束再刷新一次
      refresh: votes$
        .pipe(batchWindow(PATHQL_REFRESH_WAIT_MS, () => true))
        .subscribe(() => void requestPathql(kind, path).catch((error) => error$.next(error))),
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
 * 发起一次请求（用户操作直接调用，事件刷新由核心窗口调用）：序号递增，可与在途请求并行。
 * 返回时序号大于当前数据状态的才更新数据源，更小的静默丢弃——数据源始终表示最近发出且已返回的那次请求。
 * 返回的 promise 在结果处理完后 resolve，只用于等待完成与接收错误，调用方不直接写入数据。
 */
export async function requestPathql(kind: PathqlKind, path: string): Promise<void> {
  const entry = acquire(kind, path);
  const seq = ++entry.requested;
  entry.pending$.next(entry.pending$.value + 1);
  try {
    const snapshot = await readers[kind](path, seq);
    if (seq > entry.applied) {
      entry.applied = seq;
      entry.data$.next(snapshot);
    }
  } finally {
    entry.pending$.next(entry.pending$.value - 1);
    release(kind, path, entry);
  }
}

/**
 * 以观察方身份注册到某路径：只看该路径的数据状态，不发请求。
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
      entry.pending$
        .pipe(
          map((pending) => pending > 0),
          distinctUntilChanged(),
        )
        .subscribe((loading) => subscriber.next({ type: "loading", loading })),
    );
    subscription.add(entry.error$.subscribe((error) => subscriber.next({ type: "error", error })));
    subscription.add(triggers$(refreshOn).subscribe(() => entry.votes$.next()));
    return () => {
      subscription.unsubscribe();
      release(kind, path, entry);
    };
  });
}
