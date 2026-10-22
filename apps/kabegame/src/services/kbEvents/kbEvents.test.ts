// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchWindow } from "./batchWindow";
import { kbEvent$ } from "./eventSource";
import { imagePatches$ } from "./imagePatches";
import { on, type EventTrigger } from "./events";
import {
  lookPathql,
  pathqlAllKey,
  pathqlRequest$,
  type PathqlKind,
  type PathqlRows,
  type PathqlStatus,
  type SnapshotOf,
} from "./pathqlSource";
import { usePathqlLooker } from "./usePathqlLooker";

type Row = Record<string, unknown>;

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn<(path: string) => Promise<Row[]>>());
const pathqlAll = vi.hoisted(() => vi.fn<(queries: readonly unknown[]) => Promise<unknown[]>>());
vi.mock("@/api", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    // 与真实 listen 一致：只注销自己的回调，迟到的旧注销不能把新回调删掉
    return Promise.resolve(() => {
      if (listeners.get(event) === handler) listeners.delete(event);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlFetch, pathqlAll }));
vi.mock("@/services/albums", () => ({ FAVORITE_ALBUM_ID: "favorite" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rows(...ids: string[]): Row[] {
  return ids.map((id) => ({ id }));
}

function ids(snapshot: PathqlRows) {
  return snapshot.rows.map((row) => row.id);
}

const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlFetch.mockReset();
  pathqlAll.mockReset();
});
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
});

describe("batchWindow", () => {
  it("空闲时首个事件立即成批，窗口内的事件在窗口结束时合并发出", () => {
    vi.useFakeTimers();
    const source = new Subject<number>();
    const batches: number[][] = [];
    const subscription = source.pipe(batchWindow(500, (events: number[]) => events)).subscribe((b) => batches.push(b));
    cleanups.push(() => subscription.unsubscribe());

    source.next(1);
    source.next(2);
    source.next(3);
    expect(batches).toEqual([[1]]);
    vi.advanceTimersByTime(500);
    expect(batches).toEqual([[1], [2, 3]]);
    // 尾批发出后重新开窗，紧随其后的事件仍被合并
    source.next(4);
    expect(batches).toEqual([[1], [2, 3]]);
    vi.advanceTimersByTime(500);
    expect(batches).toEqual([[1], [2, 3], [4]]);
    vi.advanceTimersByTime(500);
    source.next(5);
    expect(batches).toEqual([[1], [2, 3], [4], [5]]);
  });
});

describe("kbEvent$", () => {
  it("同名事件共享一次监听，退订后释放", async () => {
    const seen: number[] = [];
    const a = kbEvent$("demo-event").subscribe(() => seen.push(1));
    const b = kbEvent$("demo-event").subscribe(() => seen.push(2));
    await flushPromises();
    listeners.get("demo-event")!({ payload: {} });
    expect(seen).toEqual([1, 2]);
    a.unsubscribe();
    b.unsubscribe();
    await flushPromises();
    expect(listeners.has("demo-event")).toBe(false);
  });
});

describe("imagePatches$", () => {
  it("两种事件各自防抖、各自合并成 imageId → 字段补丁", async () => {
    vi.useFakeTimers();
    const batches: Record<string, unknown>[] = [];
    const subscription = imagePatches$(500).subscribe((batch) => batches.push(Object.fromEntries(batch)));
    cleanups.push(() => subscription.unsubscribe());
    await flushPromises();
    const imageChanged = (patches: { imageIds: string[]; diff: Record<string, unknown> }[]) =>
      listeners.get("image-changed")!({ payload: { seq: 1, patches } });
    const albumChanged = (albumId: string, reason: string, imageIds: string[]) =>
      listeners.get("album-images-change")!({ payload: { seq: 1, albumIds: [albumId], reason, imageIds } });

    // 空闲时首个事件立即成批
    imageChanged([{ imageIds: ["a"], diff: { isHidden: true } }]);
    expect(batches).toEqual([{ a: { isHidden: true } }]);

    // 窗口内同一 id 的字段合并，后到覆盖先到
    imageChanged([{ imageIds: ["a", "b"], diff: { isHidden: false } }]);
    imageChanged([{ imageIds: ["a"], diff: { width: 10 } }]);
    // 收藏流独立开窗：首个收藏事件立即发出
    albumChanged("favorite", "add", ["a"]);
    expect(batches[1]).toEqual({ a: { favorite: true } });
    // 非收藏画册与非成员增删的 reason 不产生补丁；同 id 按到达顺序取最后一次
    albumChanged("other", "add", ["c"]);
    albumChanged("favorite", "order", ["c"]);
    albumChanged("favorite", "add-hidden", ["b"]);
    albumChanged("favorite", "delete", ["b"]);

    vi.advanceTimersByTime(500);
    expect(batches.slice(2)).toEqual([
      { a: { isHidden: false, width: 10 }, b: { isHidden: false } },
      { b: { favorite: false } },
    ]);

    // 一串事件全部无关时不发出
    albumChanged("other", "delete", ["a"]);
    vi.advanceTimersByTime(500);
    expect(batches).toHaveLength(4);
  });
});

/** 以观察方身份注册并记录收到的信号。 */
function look<K extends PathqlKind>(kind: K, path: string, refreshOn: readonly EventTrigger[] = []) {
  const data: SnapshotOf<K>[] = [];
  const statuses: PathqlStatus[] = [];
  const subscription = lookPathql(kind, path, refreshOn).subscribe((signal) => {
    if (signal.type === "data") data.push(signal.snapshot);
    else statuses.push(signal.status);
  });
  cleanups.push(() => subscription.unsubscribe());
  return {
    data,
    statuses,
    status: () => statuses[statuses.length - 1],
    stop: () => subscription.unsubscribe(),
  };
}

function request(kind: PathqlKind, path: string) {
  pathqlRequest$.next([kind, path]);
}

function imagesChange(reason: string) {
  listeners.get("images-change")!({ payload: { seq: 1, reason } });
}

describe("pathqlRequest$", () => {
  it("next 即返回；返回的请求取消它之前的全部 pending，更早的结果静默丢弃", async () => {
    const looker = look("rows", "p/1");
    expect(looker.data).toEqual([]); // 初始无数据
    expect(looker.status()).toEqual({ seq: 0, loading: false, error: null });

    const r1 = deferred<Row[]>();
    const r2 = deferred<Row[]>();
    const r3 = deferred<Row[]>();
    pathqlFetch.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise).mockReturnValueOnce(r3.promise);
    request("rows", "p/1");
    request("rows", "p/1");
    request("rows", "p/1");
    expect(pathqlFetch).toHaveBeenCalledTimes(3); // 三个请求并行在途
    expect(looker.status()).toEqual({ seq: 3, loading: true, error: null });

    // 2 先返回：更新数据并确认、取消 1；最新请求 3 仍在途
    r2.resolve(rows("r2"));
    await flushPromises();
    expect(looker.data.map(ids)).toEqual([["r2"]]);
    expect(looker.status()).toEqual({ seq: 3, loading: true, error: null });

    // 1 返回：已被取消，丢弃
    r1.resolve(rows("r1"));
    await flushPromises();
    expect(looker.data.map(ids)).toEqual([["r2"]]);

    // 3 返回：更新，最新请求结束
    r3.resolve(rows("r3"));
    await flushPromises();
    expect(looker.data.map(ids)).toEqual([["r2"], ["r3"]]);
    expect(looker.status()).toEqual({ seq: 3, loading: false, error: null });
  });

  it("loading / error 只属于最新请求；数据是最后可得的，序号可以落后于状态", async () => {
    const looker = look("rows", "p/err");
    const r1 = deferred<Row[]>();
    const r2 = deferred<Row[]>();
    pathqlFetch.mockReturnValueOnce(r1.promise).mockReturnValueOnce(r2.promise);
    request("rows", "p/err");
    request("rows", "p/err");

    r1.resolve(rows("r1"));
    await flushPromises();
    expect(looker.data.map((s) => s.seq)).toEqual([1]);
    expect(looker.status()).toEqual({ seq: 2, loading: true, error: null });

    // 最新请求失败：状态带上错误，数据仍是请求 1 的
    r2.reject(new Error("boom"));
    await flushPromises();
    expect(looker.status()).toEqual({ seq: 2, loading: false, error: new Error("boom") });
    expect(looker.data.map(ids)).toEqual([["r1"]]);

    // 更早的请求失败：只确认、取消它之前的 pending，不进状态；新请求开始时清掉旧错误
    const r3 = deferred<Row[]>();
    const r4 = deferred<Row[]>();
    pathqlFetch.mockReturnValueOnce(r3.promise).mockReturnValueOnce(r4.promise);
    request("rows", "p/err");
    request("rows", "p/err");
    expect(looker.status()).toEqual({ seq: 4, loading: true, error: null });
    r3.reject(new Error("old"));
    await flushPromises();
    expect(looker.status()).toEqual({ seq: 4, loading: true, error: null });
    r4.resolve(rows("r4"));
    await flushPromises();
    expect(looker.status()).toEqual({ seq: 4, loading: false, error: null });
    expect(looker.data.map(ids)).toEqual([["r1"], ["r4"]]);
  });

  it("all 的规范化 key 不受字段顺序和 list 默认值影响", () => {
    expect(
      pathqlAllKey([
        { kind: "list", path: "images://gallery" },
        { kind: "count", path: "c/1" },
      ]),
    ).toBe(
      pathqlAllKey([
        { path: "images://gallery", withCount: false, kind: "list" },
        { path: "c/1", kind: "count" },
      ]),
    );
    expect(pathqlAllKey([{ kind: "list", path: "p", withCount: true }])).not.toBe(
      pathqlAllKey([{ kind: "list", path: "p" }]),
    );
  });

  it("all 返回整批 results，沿用 pending 窗口并丢弃更早返回", async () => {
    const queries = [
      { kind: "count", path: "c/1" },
      { kind: "count", path: "c/all" },
    ] as const;
    const key = pathqlAllKey(queries);
    const looker = look("all", key);
    const oldRead = deferred<unknown[]>();
    const newRead = deferred<unknown[]>();
    pathqlAll.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    request("all", key);
    request("all", key);
    expect(pathqlAll).toHaveBeenLastCalledWith(queries);
    expect(looker.status()).toEqual({ seq: 2, loading: true, error: null });
    newRead.resolve([42, 100]);
    await flushPromises();
    oldRead.resolve([41, 99]);
    await flushPromises();
    expect(looker.data).toEqual([{ results: [42, 100], seq: 2 }]);
    expect(looker.status()).toEqual({ seq: 2, loading: false, error: null });
  });

  it("后注册的观察方先拿到最后可得的数据与最新状态", async () => {
    look("rows", "p/2");
    pathqlFetch.mockResolvedValueOnce(rows("x"));
    request("rows", "p/2");
    await flushPromises();
    const late = look("rows", "p/2");
    expect(late.data.map(ids)).toEqual([["x"]]);
    expect(late.status()).toEqual({ seq: 1, loading: false, error: null });
  });

  it("没有观察方的路径请求返回后即回收，后来者不拿到旧数据", async () => {
    pathqlFetch.mockResolvedValueOnce(rows("gone"));
    request("rows", "p/3");
    await flushPromises();
    const late = look("rows", "p/3");
    expect(late.data).toEqual([]);
    expect(late.status()).toEqual({ seq: 0, loading: false, error: null });
  });
});

describe("核心刷新窗口", () => {
  it("同一路径的观察方各带过滤器：任一同意就在窗口内刷新一次，结果推给全部观察方", async () => {
    vi.useFakeTimers();
    const adds = look("rows", "w/1", [on("images-change", (p) => p.reason === "add")]);
    const deletes = look("rows", "w/1", [on("images-change", (p) => p.reason === "delete")]);
    await flushPromises();

    // 没有过滤器同意：不刷新
    imagesChange("change");
    await flushPromises();
    expect(pathqlFetch).not.toHaveBeenCalled();

    // 只有一个同意：空闲时立即刷新一次，两个观察方都看到
    pathqlFetch.mockResolvedValueOnce(rows("d"));
    imagesChange("delete");
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    expect(adds.data.map(ids)).toEqual([["d"]]);
    expect(deletes.data.map(ids)).toEqual([["d"]]);
  });

  it("统一 500ms 窗口：窗口内多次同意（来自不同观察方）合并到窗口结束只刷新一次", async () => {
    vi.useFakeTimers();
    look("rows", "w/2", [on("images-change", (p) => p.reason === "add")]);
    look("rows", "w/2", [on("images-change", (p) => p.reason === "delete")]);
    await flushPromises();
    pathqlFetch.mockResolvedValue(rows("x"));

    imagesChange("add");
    imagesChange("delete");
    imagesChange("add");
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
  });

  it("观察方全部退订后该路径不再随事件刷新", async () => {
    vi.useFakeTimers();
    const looker = look("rows", "w/3", [on("images-change")]);
    await flushPromises();
    looker.stop();
    const other = look("rows", "w/other", [on("images-change", () => false)]); // 保持事件源在监听
    await flushPromises();
    imagesChange("add");
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(pathqlFetch).not.toHaveBeenCalled();
    expect(other.data).toEqual([]);
  });

  it("事件触发的刷新失败经最新状态推给观察方", async () => {
    const looker = look("rows", "w/4", [on("images-change")]);
    await flushPromises();
    pathqlFetch.mockRejectedValueOnce(new Error("boom"));
    imagesChange("add");
    await flushPromises();
    expect(looker.statuses.map((s) => s.loading)).toEqual([false, true, false]);
    expect(looker.status()).toEqual({ seq: 1, loading: false, error: new Error("boom") });
  });
});

describe("usePathqlLooker", () => {
  function mountLooker(key = ref<string | null>("g/1"), refreshOn: readonly EventTrigger[] = [on("images-change")]) {
    const results: PathqlRows[] = [];
    const errors: unknown[] = [];
    let looker!: ReturnType<typeof usePathqlLooker<"rows">>;
    const wrapper = mount(
      defineComponent({
        setup() {
          looker = usePathqlLooker({
            kind: "rows",
            key: () => key.value,
            refreshOn,
            onResult: (snapshot) => void results.push(snapshot),
            onError: (error) => void errors.push(error),
          });
          return () => null;
        },
      }),
    );
    cleanups.push(() => wrapper.unmount());
    return { key, results, errors, looker: () => looker };
  }

  it("观察方不发请求，只看到用户请求或事件刷新的结果", async () => {
    pathqlFetch.mockResolvedValueOnce(rows("user")).mockResolvedValueOnce(rows("event"));
    const { results } = mountLooker();
    await flushPromises();
    expect(pathqlFetch).not.toHaveBeenCalled();

    request("rows", "g/1");
    await flushPromises();
    imagesChange("add");
    await flushPromises();
    expect(results.map(ids)).toEqual([["user"], ["event"]]);
  });

  it("最新请求失败时通知 onError，并暴露 error", async () => {
    const { errors, looker } = mountLooker(ref<string | null>("g/err"));
    pathqlFetch.mockRejectedValueOnce(new Error("boom"));
    request("rows", "g/err");
    await flushPromises();
    expect(errors).toEqual([new Error("boom")]);
    expect(looker().error.value).toEqual(new Error("boom"));
    expect(looker().loading.value).toBe(false);
  });

  it("key 为 null 时不注册，事件不触发请求", async () => {
    mountLooker(ref<string | null>(null));
    look("rows", "keep-listening", [on("images-change", () => false)]);
    await flushPromises();
    imagesChange("add");
    await flushPromises();
    expect(pathqlFetch).not.toHaveBeenCalled();
  });

  it("换 key 后旧路径的迟到结果与在途状态都不影响新观察，事件只刷新新路径", async () => {
    const oldRead = deferred<Row[]>();
    const newRead = deferred<Row[]>();
    pathqlFetch.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const { key, results, looker } = mountLooker(ref<string | null>("g/old"));

    request("rows", "g/old");
    expect(looker().loading.value).toBe(true);
    key.value = "g/new";
    await nextTick();
    expect(looker().loading.value).toBe(false);
    request("rows", "g/new");
    expect(looker().loading.value).toBe(true);
    oldRead.resolve(rows("old"));
    await flushPromises();
    expect(results).toEqual([]);
    newRead.resolve(rows("new"));
    await flushPromises();
    expect(results.map(ids)).toEqual([["new"]]);
    expect(looker().loading.value).toBe(false);

    pathqlFetch.mockResolvedValueOnce(rows("new-2"));
    imagesChange("add");
    await flushPromises();
    expect(pathqlFetch).toHaveBeenLastCalledWith("g/new");
    expect(results.map(ids)).toEqual([["new"], ["new-2"]]);
  });
});
