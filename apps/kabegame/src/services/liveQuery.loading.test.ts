// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveQuery, type ViewSnapshot } from "./liveQuery";

const pathqlView = vi.hoisted(() => vi.fn<() => Promise<ViewSnapshot>>());
vi.mock("@/services/pathql", () => ({ pathqlView }));
vi.mock("@/services/dataChangeHub", () => ({ subscribeChanges: () => vi.fn() }));
vi.mock("@/debugIngest", () => ({ sendDebugEvent: vi.fn() }));

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  pathqlView.mockReset();
});
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));

function deferred() {
  let resolve!: (value: ViewSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ViewSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createQuery(onResult: (snapshot: ViewSnapshot) => void | Promise<void> = () => {}) {
  const key = ref({ rows: "gallery/1", count: "gallery/all" });
  let live!: ReturnType<typeof useLiveQuery>;
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          live = useLiveQuery({ key: () => key.value, waitMs: 0, relevant: () => true, onResult });
          return () => null;
        },
      }),
    ),
  );
  return { key, live };
}

const snapshot = { rows: [], total: 0, seq: 1 } satisfies ViewSnapshot;

describe("当前页查询加载状态", () => {
  it("必须等快照应用结束才从 loading 进入就绪", async () => {
    const fetch = deferred();
    pathqlView.mockReturnValue(fetch.promise);
    let finishApply!: () => void;
    const { live } = createQuery(() => new Promise<void>((resolve) => (finishApply = resolve)));
    const request = live.refetch();
    expect(live.loading.value).toBe(true);
    fetch.resolve(snapshot);
    await Promise.resolve();
    expect(live.loading.value).toBe(true);
    finishApply();
    await request;
    expect(live.loading.value).toBe(false);
  });

  it("旧页读取不影响新页状态，旧页返回也不会提前结束新页 loading", async () => {
    const first = deferred();
    const second = deferred();
    pathqlView.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { key, live } = createQuery();
    const oldRequest = live.refetch();
    key.value = { rows: "gallery/2", count: "gallery/all" };
    expect(live.loading.value).toBe(false);
    const newRequest = live.refetch();
    first.resolve(snapshot);
    await oldRequest;
    expect(live.loading.value).toBe(true);
    second.resolve(snapshot);
    await newRequest;
    expect(live.loading.value).toBe(false);
  });

  it("同一页并发读取须全部结束，不能由第一条返回提前释放就绪门控", async () => {
    const first = deferred();
    const second = deferred();
    pathqlView.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { live } = createQuery();
    const one = live.refetch();
    const two = live.refetch();
    first.resolve(snapshot);
    await one;
    expect(live.loading.value).toBe(true);
    second.resolve(snapshot);
    await two;
    expect(live.loading.value).toBe(false);
  });

  it("失败也释放读取计数，不把页面永久卡在 loading", async () => {
    const fetch = deferred();
    pathqlView.mockReturnValue(fetch.promise);
    const { live } = createQuery();
    const request = live.refetch();
    fetch.reject(new Error("unavailable"));
    await expect(request).rejects.toThrow("unavailable");
    expect(live.loading.value).toBe(false);
  });
});
