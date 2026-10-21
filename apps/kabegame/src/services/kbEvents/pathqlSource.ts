import { BehaviorSubject, Observable, ReplaySubject, distinctUntilChanged, map } from "rxjs";
import { pathqlCount, pathqlView } from "@/services/pathql";
import type { RowsSnapshot, TotalSnapshot } from "@/services/liveQuery";

export type PathqlKind = "rows" | "total";
export type SnapshotOf<K extends PathqlKind> = K extends "rows" ? RowsSnapshot : TotalSnapshot;

const readers: { [K in PathqlKind]: (path: string) => Promise<SnapshotOf<K>> } = {
  rows: pathqlView,
  total: pathqlCount,
};

interface Entry<S extends { seq: number }> {
  /** 已发布快照的最大 seq；-1 表示尚无数据。 */
  seq: number;
  /** rows / count 数据源：只发出 seq 不倒退的快照，新订阅者先拿到最新一份。 */
  data$: ReplaySubject<S>;
  pending$: BehaviorSubject<number>;
  /** 最近发出的读取，供事件通道合并；结果发布后才 resolve。 */
  inFlight: Promise<S> | null;
  refs: number;
}

// 值的快照类型由 key 中的 kind 决定，读取时按 kind 还原
const entries = new Map<string, unknown>();

function acquire<K extends PathqlKind>(kind: K, path: string): Entry<SnapshotOf<K>> {
  const id = `${kind}\u0000${path}`;
  let entry = entries.get(id) as Entry<SnapshotOf<K>> | undefined;
  if (!entry) {
    entry = {
      seq: -1,
      data$: new ReplaySubject(1),
      pending$: new BehaviorSubject(0),
      inFlight: null,
      refs: 0,
    };
    entries.set(id, entry);
  }
  entry.refs++;
  return entry;
}

// 没有订阅者也没有在途读取时回收，避免把已离开路径的旧数据重放给后来者。
function release<K extends PathqlKind>(kind: K, path: string, entry: Entry<SnapshotOf<K>>) {
  entry.refs--;
  const id = `${kind}\u0000${path}`;
  if (entry.refs <= 0 && entries.get(id) === entry) entries.delete(id);
}

function read<K extends PathqlKind>(kind: K, path: string, entry: Entry<SnapshotOf<K>>): Promise<SnapshotOf<K>> {
  const request = readers[kind](path).then((snapshot) => {
    if (snapshot.seq >= entry.seq) {
      entry.seq = snapshot.seq;
      entry.data$.next(snapshot);
    }
    return snapshot;
  });
  entry.inFlight = request;
  const clear = () => {
    if (entry.inFlight === request) entry.inFlight = null;
  };
  request.then(clear, clear);
  return request;
}

export interface PathqlRequestOptions {
  /** 已知的最新变更序号：数据源已不旧于它时跳过；合并到的读取早于它时再读一次。 */
  minSeq?: number;
  /** 允许合并同路径的在途读取（事件通道）；显式加载与写后补读必须新开读取。 */
  join?: boolean;
}

/**
 * 请求通道：发起或合并一次读取。结果只经 `pathqlData$` 发布，调用方不直接写入；
 * 返回的 promise 在结果发布后 resolve，用于等待完成与接收错误。
 */
export async function requestPathql(kind: PathqlKind, path: string, opts: PathqlRequestOptions = {}): Promise<void> {
  const entry = acquire(kind, path);
  const minSeq = opts.minSeq ?? 0;
  try {
    if (minSeq > 0 && entry.seq >= minSeq) return;
    entry.pending$.next(entry.pending$.value + 1);
    try {
      const snapshot = opts.join && entry.inFlight ? await entry.inFlight : await read(kind, path, entry);
      if (snapshot.seq < minSeq) await read(kind, path, entry);
    } finally {
      entry.pending$.next(entry.pending$.value - 1);
    }
  } finally {
    release(kind, path, entry);
  }
}

function observeEntry<K extends PathqlKind, T>(
  kind: K,
  path: string,
  pick: (entry: Entry<SnapshotOf<K>>) => Observable<T>,
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const entry = acquire(kind, path);
    const subscription = pick(entry).subscribe(subscriber);
    return () => {
      subscription.unsubscribe();
      release(kind, path, entry);
    };
  });
}

/** 某路径的 rows / count 数据源，与事件源无关：两种请求通道的结果都从这里落地。 */
export function pathqlData$<K extends PathqlKind>(kind: K, path: string): Observable<SnapshotOf<K>> {
  return observeEntry(kind, path, (entry) => entry.data$);
}

/** 该路径是否有在途读取；旧路径的迟到读取不影响新路径。 */
export function pathqlLoading$(kind: PathqlKind, path: string): Observable<boolean> {
  return observeEntry(kind, path, (entry) =>
    entry.pending$.pipe(
      map((pending) => pending > 0),
      distinctUntilChanged(),
    ),
  );
}
