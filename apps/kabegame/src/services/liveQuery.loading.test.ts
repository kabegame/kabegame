// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveQuery, type RowsSnapshot, type TotalSnapshot } from "./liveQuery";
import type { ChangeBatch } from "./dataChangeHub";

const subscriptions = vi.hoisted(() => [] as { onBatch: (batch: ChangeBatch) => Promise<void> | void }[]);
vi.mock("@/services/dataChangeHub", () => ({
  subscribeChanges: (subscriber: { onBatch: (batch: ChangeBatch) => Promise<void> | void }) => {
    subscriptions.push(subscriber);
    return vi.fn();
  },
}));
vi.mock("@/debugIngest", () => ({ sendDebugEvent: vi.fn() }));

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  subscriptions.splice(0);
});
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

function deferred<S>() {
  let resolve!: (value: S) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<S>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createRowsQuery(
  read: (key: string) => Promise<RowsSnapshot>,
  onResult: (snapshot: RowsSnapshot) => void | Promise<void> = () => {},
) {
  const key = ref("gallery/1");
  let live!: ReturnType<typeof useLiveQuery<RowsSnapshot>>;
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          live = useLiveQuery({
            key: () => key.value,
            read,
            kind: "rows",
            waitMs: 0,
            relevant: () => true,
            onResult,
          });
          return () => null;
        },
      }),
    ),
  );
  return { key, live };
}

function batch(maxSeq: number): ChangeBatch {
  return {
    images: new Set(["updated"]),
    imageIds: new Set(),
    imagePatches: new Map(),
    taskIds: new Set(),
    surfRecordIds: new Set(),
    pluginIds: new Set(),
    albumImages: new Set(),
    albumIds: new Set(),
    albumImageIds: new Set(),
    favoriteOps: [],
    albumStructure: new Set(),
    albumPaths: new Set(),
    albumPathsWildcard: false,
    wildcard: { task: false, surf: false, plugin: false },
    maxSeq,
  };
}

const rowsSnapshot = { rows: [], seq: 1 } satisfies RowsSnapshot;

describe("当前页查询加载状态", () => {
  it("必须等快照应用结束才从 loading 进入就绪", async () => {
    const fetch = deferred<RowsSnapshot>();
    const read = vi.fn(() => fetch.promise);
    let finishApply!: () => void;
    const { live } = createRowsQuery(read, () => new Promise<void>((resolve) => (finishApply = resolve)));
    const request = live.refetch();
    expect(live.loading.value).toBe(true);
    fetch.resolve(rowsSnapshot);
    await Promise.resolve();
    expect(live.loading.value).toBe(true);
    finishApply();
    await request;
    expect(live.loading.value).toBe(false);
  });

  it("旧页读取不影响新页状态，旧页返回也不会提前结束新页 loading", async () => {
    const first = deferred<RowsSnapshot>();
    const second = deferred<RowsSnapshot>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { key, live } = createRowsQuery(read);
    const oldRequest = live.refetch();
    key.value = "gallery/2";
    expect(live.loading.value).toBe(false);
    const newRequest = live.refetch();
    first.resolve(rowsSnapshot);
    await oldRequest;
    expect(live.loading.value).toBe(true);
    second.resolve(rowsSnapshot);
    await newRequest;
    expect(live.loading.value).toBe(false);
  });

  it("同一页并发读取须全部结束，不能由第一条返回提前释放就绪门控", async () => {
    const first = deferred<RowsSnapshot>();
    const second = deferred<RowsSnapshot>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { live } = createRowsQuery(read);
    const one = live.refetch();
    const two = live.refetch();
    first.resolve(rowsSnapshot);
    await one;
    expect(live.loading.value).toBe(true);
    second.resolve(rowsSnapshot);
    await two;
    expect(live.loading.value).toBe(false);
  });

  it("失败也释放读取计数，不把页面永久卡在 loading", async () => {
    const fetch = deferred<RowsSnapshot>();
    const read = vi.fn(() => fetch.promise);
    const { live } = createRowsQuery(read);
    const request = live.refetch();
    fetch.reject(new Error("unavailable"));
    await expect(request).rejects.toThrow("unavailable");
    expect(live.loading.value).toBe(false);
  });
});

describe("单通道 live 状态", () => {
  it("行实例的 appliedSeq 前进后，总数实例仍会处理同一 maxSeq 批次", async () => {
    const rowsRead = vi.fn(async () => ({ rows: [], seq: 5 }) satisfies RowsSnapshot);
    const totalRead = vi.fn(async () => ({ total: 10, seq: 5 }) satisfies TotalSnapshot);
    let rowsQuery!: ReturnType<typeof useLiveQuery<RowsSnapshot>>;
    let totalQuery!: ReturnType<typeof useLiveQuery<TotalSnapshot>>;
    wrappers.push(
      mount(
        defineComponent({
          setup() {
            rowsQuery = useLiveQuery<RowsSnapshot>({
              key: () => "gallery/1",
              read: rowsRead,
              kind: "rows",
              waitMs: 0,
              relevant: () => true,
              onResult: () => {},
            });
            totalQuery = useLiveQuery<TotalSnapshot>({
              key: () => "gallery/all",
              read: totalRead,
              kind: "total",
              waitMs: 0,
              relevant: () => true,
              onResult: () => {},
            });
            return () => null;
          },
        }),
      ),
    );

    await rowsQuery.refetch();
    expect(subscriptions).toHaveLength(2);
    await Promise.all(subscriptions.map((subscriber) => subscriber.onBatch(batch(5))));

    expect(rowsRead).toHaveBeenCalledTimes(1);
    expect(totalRead).toHaveBeenCalledTimes(1);
    expect(totalQuery.loading.value).toBe(false);
  });

  it("autoFetch 在 key 不变时不重读，key 变化时重读", async () => {
    const key = ref("gallery/all");
    const read = vi.fn(async () => ({ total: 10, seq: 1 }) satisfies TotalSnapshot);
    wrappers.push(
      mount(
        defineComponent({
          setup() {
            useLiveQuery({
              key: () => key.value,
              read,
              kind: "total",
              waitMs: 0,
              relevant: () => true,
              onResult: () => {},
              autoFetch: true,
            });
            return () => null;
          },
        }),
      ),
    );

    await flushPromises();
    expect(read).toHaveBeenCalledTimes(1);
    key.value = "gallery/all";
    await nextTick();
    expect(read).toHaveBeenCalledTimes(1);
    key.value = "gallery/favorite";
    await nextTick();
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
