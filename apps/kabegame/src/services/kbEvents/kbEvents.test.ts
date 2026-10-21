// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RowsSnapshot } from "@/services/liveQuery";
import { batchWindow } from "./batchWindow";
import { kbEvent$ } from "./eventSource";
import { pathqlData$, requestPathql } from "./pathqlSource";
import { useLivePathql } from "./useLivePathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlView = vi.hoisted(() => vi.fn<(path: string) => Promise<RowsSnapshot>>());
vi.mock("@/api", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return Promise.resolve(() => listeners.delete(event));
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlView, pathqlCount: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rows(ids: string[], seq: number): RowsSnapshot {
  return { rows: ids.map((id) => ({ id })), seq };
}

const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlView.mockReset();
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
  it("同名事件共享一次监听，并取出 payload 的 seq", async () => {
    const seen: number[][] = [[], []];
    const a = kbEvent$("demo-event").subscribe((event) => seen[0]!.push(event.seq));
    const b = kbEvent$("demo-event").subscribe((event) => seen[1]!.push(event.seq));
    await flushPromises();
    listeners.get("demo-event")!({ payload: { seq: 7 } });
    listeners.get("demo-event")!({ payload: {} });
    expect(seen).toEqual([
      [7, 0],
      [7, 0],
    ]);
    a.unsubscribe();
    b.unsubscribe();
    await flushPromises();
    expect(listeners.has("demo-event")).toBe(false);
  });
});

describe("requestPathql", () => {
  it("数据源只发 seq 不倒退的快照；迟到的旧读取不覆盖新数据", async () => {
    const older = deferred<RowsSnapshot>();
    const newer = deferred<RowsSnapshot>();
    pathqlView.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const seen: number[] = [];
    const subscription = pathqlData$("rows", "p/1").subscribe((snapshot) => seen.push(snapshot.seq));
    cleanups.push(() => subscription.unsubscribe());

    const first = requestPathql("rows", "p/1");
    const second = requestPathql("rows", "p/1");
    newer.resolve(rows(["b"], 5));
    await second;
    older.resolve(rows(["a"], 3));
    await first;
    expect(seen).toEqual([5]);
  });

  it("事件通道合并在途读取；读取早于事件序号时再读一次；已覆盖的序号直接跳过", async () => {
    const inFlight = deferred<RowsSnapshot>();
    pathqlView.mockReturnValueOnce(inFlight.promise).mockResolvedValueOnce(rows(["c"], 9));
    const seen: number[] = [];
    const subscription = pathqlData$("rows", "p/2").subscribe((snapshot) => seen.push(snapshot.seq));
    cleanups.push(() => subscription.unsubscribe());

    const explicit = requestPathql("rows", "p/2");
    const joined = requestPathql("rows", "p/2", { join: true, minSeq: 8 });
    inFlight.resolve(rows(["a"], 4));
    await Promise.all([explicit, joined]);
    expect(pathqlView).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([4, 9]);

    await requestPathql("rows", "p/2", { join: true, minSeq: 9 });
    expect(pathqlView).toHaveBeenCalledTimes(2);
  });
});

describe("useLivePathql", () => {
  function mountLive(key = ref<string | null>("g/1")) {
    const changes = new Subject<number>();
    const results: RowsSnapshot[] = [];
    let live!: ReturnType<typeof useLivePathql<"rows">>;
    const wrapper = mount(
      defineComponent({
        setup() {
          live = useLivePathql({
            kind: "rows",
            key: () => key.value,
            changes,
            waitMs: 500,
            onResult: (snapshot) => void results.push(snapshot),
          });
          return () => null;
        },
      }),
    );
    cleanups.push(() => wrapper.unmount());
    return { key, changes, results, live: () => live };
  }

  it("事件通道防抖请求，结果从数据源落地", async () => {
    vi.useFakeTimers();
    pathqlView.mockResolvedValueOnce(rows(["a"], 3)).mockResolvedValueOnce(rows(["b"], 6));
    const { changes, results } = mountLive();

    changes.next(3);
    changes.next(5);
    changes.next(6);
    await flushPromises();
    expect(pathqlView).toHaveBeenCalledTimes(1);
    expect(results.map((s) => s.seq)).toEqual([3]);
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(pathqlView).toHaveBeenCalledTimes(2);
    expect(results.map((s) => s.seq)).toEqual([3, 6]);
  });

  it("写期间暂存事件，写后显式补读覆盖的序号放行时跳过", async () => {
    pathqlView.mockResolvedValueOnce(rows(["after-write"], 10));
    const { changes, results, live } = mountLive();

    const release = live().hold();
    changes.next(10);
    await flushPromises();
    expect(pathqlView).not.toHaveBeenCalled();
    await live().refetch();
    release();
    await flushPromises();
    expect(pathqlView).toHaveBeenCalledTimes(1);
    expect(results.map((s) => s.rows[0]!.id)).toEqual(["after-write"]);
  });

  it("未激活期间命中事件标脏，重新激活后补读", async () => {
    pathqlView.mockResolvedValueOnce(rows(["fresh"], 2));
    const { key, changes, results } = mountLive(ref<string | null>(null));

    changes.next(2);
    await flushPromises();
    expect(pathqlView).not.toHaveBeenCalled();
    key.value = "g/1";
    await nextTick();
    await flushPromises();
    expect(results.map((s) => s.rows[0]!.id)).toEqual(["fresh"]);
  });

  it("换路径后旧路径的迟到结果与在途状态都不影响新路径", async () => {
    const oldRead = deferred<RowsSnapshot>();
    const newRead = deferred<RowsSnapshot>();
    pathqlView.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const { key, results, live } = mountLive();

    const first = live().refetch();
    expect(live().loading.value).toBe(true);
    key.value = "g/2";
    expect(live().loading.value).toBe(false);
    const second = live().refetch();
    expect(live().loading.value).toBe(true);
    oldRead.resolve(rows(["old"], 8));
    await first;
    expect(results).toEqual([]);
    newRead.resolve(rows(["new"], 5));
    await second;
    expect(results.map((s) => s.rows[0]!.id)).toEqual(["new"]);
    expect(live().loading.value).toBe(false);
  });
});
