// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePagedRunConfigs } from "./usePagedRunConfigs";
import { pathqlAllKey, pathqlRequest$, type PathqlRequest } from "@/services/kbEvents";
import { RUN_CONFIG_PAGE_SIZE } from "@/services/runConfigs";
import type { PathqlQuery } from "@/services/pathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlAll = vi.hoisted(() => vi.fn<(queries: readonly PathqlQuery[]) => Promise<unknown[]>>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));

function deferred() {
  let resolve!: (value: unknown[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const row = (id: string) => ({ id, name: id, pluginId: "test", createdAt: 1 });
const rows = (count = RUN_CONFIG_PAGE_SIZE) => Array.from({ length: count }, (_, i) => row(String(i)));
const cleanups: (() => void)[] = [];
beforeEach(() => pathqlAll.mockReset());
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});
function fixture() {
  const base = ref("sort/created/desc/");
  const count = ref("");
  const requests: PathqlRequest[] = [];
  const subscription = pathqlRequest$.subscribe((request) => requests.push(request));
  cleanups.push(() => subscription.unsubscribe());
  let model!: ReturnType<typeof usePagedRunConfigs>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = usePagedRunConfigs({ basePath: () => base.value, countPath: () => count.value });
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { model, base, count, requests };
}
const emit = (name: string, payload: unknown) => listeners.get(name)?.({ payload });

describe("usePagedRunConfigs 观察累计窗口", () => {
  it("start 只请求一次 all key，同行快照落地 items、total 与 hasMore", async () => {
    const pending = deferred();
    pathqlAll.mockReturnValue(pending.promise);
    const { model, requests } = fixture();
    expect(pathqlAll).not.toHaveBeenCalled();
    model.start();
    const queries = [
      { kind: "fetch", path: `run_configs://sort/created/desc/x${RUN_CONFIG_PAGE_SIZE}x/1` },
      { kind: "count", path: "run_configs://" },
    ] as const;
    expect(requests).toEqual([["all", pathqlAllKey(queries)]]);
    expect(pathqlAll).toHaveBeenCalledExactlyOnceWith(queries);
    expect(model.loading.value).toBe(true);
    expect(model.hasMore.value).toBe(false);
    pending.resolve([rows(), 45]);
    await flushPromises();
    expect(model.items.value.map((config) => config.id)).toEqual(rows().map((config) => config.id));
    expect(model.total.value).toBe(45);
    expect(model.hasMore.value).toBe(true);
    expect(model.loading.value).toBe(false);
  });

  it("换路径清空并切换 key，旧响应不能覆盖新窗口", async () => {
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model, base, count, requests } = fixture();
    model.start();
    await flushPromises();
    const old = deferred();
    pathqlAll.mockReturnValueOnce(old.promise);
    model.loadMore();
    const next = deferred();
    pathqlAll.mockReturnValueOnce(next.promise);
    base.value = "last/failed/sort/name/";
    count.value = "last/failed/";
    model.start();
    expect(model.items.value).toEqual([]);
    expect(model.total.value).toBe(0);
    expect(model.hasMore.value).toBe(false);
    expect(requests.at(-1)).toEqual([
      "all",
      pathqlAllKey([
        { kind: "fetch", path: `run_configs://last/failed/sort/name/x${RUN_CONFIG_PAGE_SIZE}x/1` },
        { kind: "count", path: "run_configs://last/failed" },
      ]),
    ]);
    next.resolve([[row("new")], 1]);
    await flushPromises();
    old.resolve([rows(40), 45]);
    await flushPromises();
    expect(model.items.value.map((config) => config.id)).toEqual(["new"]);
    expect(model.total.value).toBe(1);
    expect(model.hasMore.value).toBe(false);
  });

  it("loadMore 扩大窗口并同时读总数，失败重试同一个 key", async () => {
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model, requests } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockRejectedValueOnce(new Error("读取失败"));
    model.loadMore();
    const moreKey = requests.at(-1);
    expect(moreKey).toEqual([
      "all",
      pathqlAllKey([
        { kind: "fetch", path: `run_configs://sort/created/desc/x${RUN_CONFIG_PAGE_SIZE * 2}x/1` },
        { kind: "count", path: "run_configs://" },
      ]),
    ]);
    await flushPromises();
    expect(model.loading.value).toBe(false);
    expect(model.items.value).toHaveLength(RUN_CONFIG_PAGE_SIZE);
    expect(model.hasMore.value).toBe(true);
    pathqlAll.mockResolvedValueOnce([rows(RUN_CONFIG_PAGE_SIZE * 2), 45]);
    model.loadMore();
    expect(requests.at(-1)).toEqual(moreKey);
    expect(requests).toHaveLength(3);
    await flushPromises();
    expect(model.items.value).toHaveLength(RUN_CONFIG_PAGE_SIZE * 2);
    expect(model.total.value).toBe(45);
    model.loadMore();
    expect(pathqlAll.mock.calls.at(-1)?.[0][0].path).toContain(`x${RUN_CONFIG_PAGE_SIZE * 3}x/1`);
    await flushPromises();
  });

  it.each([
    ["auto-config-change", { configId: "a", reason: "configchange" }],
    ["tasks-change", { type: "TaskAdded", task: { id: "t", plugin_id: "test", run_config_id: "a" } }],
    ["tasks-change", { type: "TaskChanged", taskId: "manual", diff: { status: "failed" } }],
    ["tasks-change", { type: "TaskDeleted", task_id: "t" }],
  ])("%s %j 触发核心窗口刷新", async (name, payload) => {
    vi.useFakeTimers();
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockClear();
    emit(name, payload);
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
  });

  it("张数与进度事件不请求，只补丁 lastTask.id 匹配的行与允许的字段", async () => {
    vi.useFakeTimers();
    pathqlAll.mockResolvedValue([
      [
        { ...row("a"), last_task_id: "t", last_task_start_time: 1, last_task_status: "completed" },
        { ...row("b"), last_task_id: "other", last_task_start_time: 2, last_task_status: "completed" },
      ],
      2,
    ]);
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockClear();
    const other = model.items.value[1];
    emit("tasks-change", {
      type: "TaskChanged",
      task_id: "t",
      diff: {
        success_count: 6,
        failed_count: 2,
        progress: 50,
        end_time: 10,
        error: "部分失败",
        start_time: 99,
      },
    });
    emit("tasks-change", { type: "TaskChanged", taskId: "missing", diff: { successCount: 100 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlAll).not.toHaveBeenCalled();
    expect(model.items.value[0].lastTask).toEqual({
      id: "t",
      status: "completed",
      startTime: 1,
      endTime: 10,
      successCount: 6,
      failedCount: 2,
      error: "部分失败",
    });
    expect(model.items.value[0].lastResult).toBe("partial");
    expect(model.items.value[1]).toBe(other);
    const patched = model.items.value[0];
    emit("tasks-change", { type: "TaskChanged", taskId: "t", diff: { progress: 80 } });
    emit("tasks-change", { type: "TaskAdded", task: { id: "manual", pluginId: "test" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlAll).not.toHaveBeenCalled();
    expect(model.items.value[0]).toBe(patched);
  });

  it("loading 延迟展示；stop 清空并停止事件刷新与旧结果落地", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    pathqlAll.mockReturnValue(pending.promise);
    const { model } = fixture();
    model.start();
    model.loadMore();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    expect(model.showLoading.value).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(model.showLoading.value).toBe(true);
    model.stop();
    expect(model.loading.value).toBe(false);
    expect(model.showLoading.value).toBe(false);
    emit("auto-config-change", { reason: "configadd", configId: "a" });
    pending.resolve([rows(), 45]);
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    expect(model.items.value).toEqual([]);
    expect(model.total.value).toBe(0);
    expect(model.hasMore.value).toBe(false);
  });
});
