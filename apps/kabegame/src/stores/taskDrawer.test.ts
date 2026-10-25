// @vitest-environment happy-dom
import { flushPromises } from "@vue/test-utils";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathqlAllKey, pathqlRequest$ } from "@/services/kbEvents";
import { useTaskDrawerStore } from "./taskDrawer";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlAll = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));
vi.mock("@/track/umami", () => ({ trackEvent: vi.fn() }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlAll.mockReset().mockResolvedValue([
    [
      { name: "running", meta: { count: 2 } },
      { name: "pending", meta: { count: "3" } },
      { name: "completed", meta: { count: 7 } },
      { name: "failed", meta: null },
    ],
  ]);
  const pinia = createPinia();
  setActivePinia(pinia);
  cleanups.push(() => disposePinia(pinia));
});
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});
const emit = (payload: unknown) => listeners.get("tasks-change")?.({ payload });

describe("taskDrawer 状态计数观察方", () => {
  it("创建时请求一次 list all key，按 meta.count 计算徽章和终态数量", async () => {
    const store = useTaskDrawerStore();
    expect(pathqlAll).toHaveBeenCalledExactlyOnceWith([{ kind: "list", path: "tasks://status", withCount: false }]);
    await flushPromises();
    expect(store.statusCounts).toEqual({ running: 2, pending: 3, completed: 7, failed: 0 });
    expect(store.activeTasksCount).toBe(5);
    expect(store.finishedTasksCount).toBe(7);
  });

  it.each([
    { type: "TaskAdded", task: { id: "t" } },
    { type: "TaskDeleted", task_id: "t" },
    { type: "TaskChanged", taskId: "t", diff: { status: "completed" } },
  ])("%j 触发计数刷新", async (payload) => {
    vi.useFakeTimers();
    useTaskDrawerStore();
    await flushPromises();
    pathqlAll.mockClear();
    emit(payload);
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
  });

  it("进度与 startTime 不刷新计数，refreshCounts 即发即返回，销毁后不再监听", async () => {
    vi.useFakeTimers();
    const store = useTaskDrawerStore();
    await flushPromises();
    pathqlAll.mockClear();
    emit({ type: "TaskChanged", taskId: "t", diff: { progress: 50, start_time: 20, success_count: 3 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlAll).not.toHaveBeenCalled();
    const requests: unknown[] = [];
    const subscription = pathqlRequest$.subscribe((request) => requests.push(request));
    cleanups.push(() => subscription.unsubscribe());
    let resolve!: (result: unknown[]) => void;
    pathqlAll.mockReturnValueOnce(
      new Promise<unknown[]>((done) => {
        resolve = done;
      }),
    );
    expect(store.refreshCounts()).toBeUndefined();
    expect(requests).toEqual([["all", pathqlAllKey([{ kind: "list", path: "tasks://status" }])]]);
    expect(store.activeTasksCount).toBe(5);
    store.$dispose();
    pathqlAll.mockClear();
    emit({ type: "TaskDeleted", taskId: "t" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlAll).not.toHaveBeenCalled();
    resolve([[]]);
    await flushPromises();
  });
});
