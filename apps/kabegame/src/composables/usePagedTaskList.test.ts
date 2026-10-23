// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePagedTaskList } from "./usePagedTaskList";
import { pathqlAllKey, pathqlRequest$, type PathqlRequest } from "@/services/kbEvents";
import { TASK_PAGE_SIZE } from "@/services/tasks";
import type { PathqlQuery } from "@/services/pathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlAll = vi.hoisted(() => vi.fn<(queries: readonly PathqlQuery[]) => Promise<unknown[]>>());
const fetchRunConfig = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll, pathqlFetch: vi.fn() }));
vi.mock("@/services/runConfigs", () => ({ fetchRunConfig }));

function deferred() {
  let resolve!: (value: unknown[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const row = (id: string) => ({ id, plugin_id: "test", status: "running", progress: 10, start_time: 1 });
const rows = (count = TASK_PAGE_SIZE) => Array.from({ length: count }, (_, i) => row(String(i)));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  pathqlAll.mockReset();
  fetchRunConfig.mockReset();
});
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});
function fixture() {
  const base = ref("");
  const requests: PathqlRequest[] = [];
  const subscription = pathqlRequest$.subscribe((request) => requests.push(request));
  cleanups.push(() => subscription.unsubscribe());
  const onError = vi.fn();
  let model!: ReturnType<typeof usePagedTaskList>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = usePagedTaskList({ basePath: () => base.value, onError });
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { model, base, requests, onError };
}
const emit = (payload: unknown) => listeners.get("tasks-change")?.({ payload });

describe("usePagedTaskList 观察累计窗口", () => {
  it("首读同批落地行与总数，只请求一次 all key", async () => {
    const pending = deferred();
    pathqlAll.mockReturnValue(pending.promise);
    const { model, requests } = fixture();
    expect(pathqlAll).not.toHaveBeenCalled();
    model.start();
    const queries = [
      { kind: "fetch", path: "tasks://x20x/1" },
      { kind: "count", path: "tasks://" },
    ] as const;
    expect(requests).toEqual([["all", pathqlAllKey(queries)]]);
    expect(pathqlAll).toHaveBeenCalledExactlyOnceWith(queries);
    expect(model.loading.value).toBe(true);
    expect(model.hasMore.value).toBe(false);
    pending.resolve([rows(), 45]);
    await flushPromises();
    expect(model.items.value.map((task) => task.id)).toEqual(rows().map((task) => task.id));
    expect(model.total.value).toBe(45);
    expect(model.hasMore.value).toBe(true);
    expect(model.loading.value).toBe(false);
  });

  it("loadMore 请求 x40x/1，失败保留数据并重试同一窗口", async () => {
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model, requests, onError } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockRejectedValueOnce(new Error("读取失败"));
    model.loadMore();
    const moreKey = requests.at(-1);
    expect(moreKey).toEqual([
      "all",
      pathqlAllKey([
        { kind: "fetch", path: "tasks://x40x/1" },
        { kind: "count", path: "tasks://" },
      ]),
    ]);
    await flushPromises();
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("读取失败"));
    expect(model.loading.value).toBe(false);
    expect(model.items.value).toHaveLength(20);
    expect(model.total.value).toBe(45);
    expect(model.hasMore.value).toBe(true);
    pathqlAll.mockResolvedValueOnce([rows(40), 45]);
    model.loadMore();
    expect(requests.at(-1)).toEqual(moreKey);
    await flushPromises();
    expect(model.items.value).toHaveLength(40);
    pathqlAll.mockResolvedValueOnce([rows(45), 45]);
    model.loadMore();
    expect(pathqlAll.mock.calls.at(-1)?.[0][0].path).toBe("tasks://x60x/1");
    await flushPromises();
    expect(model.hasMore.value).toBe(false);
  });

  it("搜索 stop/start 清空并换 key，旧响应不能覆盖新结果", async () => {
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model, base, requests } = fixture();
    model.start();
    await flushPromises();
    const old = deferred();
    pathqlAll.mockReturnValueOnce(old.promise);
    model.loadMore();
    model.stop();
    base.value = "run_config/a/";
    const next = deferred();
    pathqlAll.mockReturnValueOnce(next.promise);
    model.start();
    expect(model.items.value).toEqual([]);
    expect(model.total.value).toBe(0);
    expect(requests.at(-1)).toEqual([
      "all",
      pathqlAllKey([
        { kind: "fetch", path: "tasks://run_config/a/x20x/1" },
        { kind: "count", path: "tasks://run_config/a" },
      ]),
    ]);
    next.resolve([[row("new")], 1]);
    await flushPromises();
    old.resolve([rows(40), 45]);
    await flushPromises();
    expect(model.items.value.map((task) => task.id)).toEqual(["new"]);
    expect(model.total.value).toBe(1);
  });

  it.each([
    { type: "TaskAdded", task: { id: "new", plugin_id: "test" } },
    { type: "TaskDeleted", task_id: "0" },
    { type: "TaskChanged", taskId: "0", diff: { startTime: 2 } },
    { type: "TaskChanged", task_id: "0", diff: { start_time: 0 } },
  ])("%j 由核心刷新累计行与总数", async (payload) => {
    vi.useFakeTimers();
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockClear();
    emit(payload);
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
  });

  it("进度、张数、状态、结束与错误只补丁已有行，纯进度保持单调与 100ms 节流", async () => {
    vi.useFakeTimers();
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockClear();
    const other = model.items.value[1];
    emit({ type: "TaskChanged", taskId: "0", diff: { progress: 30 } });
    expect(model.items.value[0].progress).toBe(30);
    emit({ type: "TaskChanged", taskId: "0", diff: { progress: 40 } });
    expect(model.items.value[0].progress).toBe(30);
    await vi.advanceTimersByTimeAsync(100);
    emit({ type: "TaskChanged", taskId: "0", diff: { progress: 20 } });
    expect(model.items.value[0].progress).toBe(30);
    emit({ type: "TaskChanged", taskId: "0", diff: { progress: 60 } });
    expect(model.items.value[0].progress).toBe(60);
    emit({ type: "TaskChanged", taskId: "missing", diff: { progress: 80 } });
    emit({
      type: "TaskChanged",
      task_id: "0",
      diff: {
        status: "completed",
        success_count: 6,
        failed_count: 2,
        deleted_count: 1,
        dedup_count: 3,
        end_time: 10,
        error: "部分失败",
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(model.items.value[0]).toMatchObject({
      progress: 100,
      status: "completed",
      successCount: 6,
      failedCount: 2,
      deletedCount: 1,
      dedupCount: 3,
      endTime: 10,
      error: "部分失败",
    });
    expect(model.items.value[1]).toBe(other);
    expect(model.total.value).toBe(45);
    expect(pathqlAll).not.toHaveBeenCalled();
  });

  it("配置改名按 id 读取、删除清空名称，不请求任务列表；patch 保留本地补丁接口", async () => {
    pathqlAll.mockResolvedValue([[{ ...row("0"), run_config_id: "a", run_config_name: "旧名" }, row("1")], 2]);
    fetchRunConfig.mockResolvedValue({ id: "a", name: "新名" });
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockClear();
    listeners.get("auto-config-change")?.({ payload: { reason: "configchange", configId: "a" } });
    await flushPromises();
    expect(fetchRunConfig).toHaveBeenCalledExactlyOnceWith("a");
    expect(model.items.value[0].runConfigName).toBe("新名");
    listeners.get("auto-config-change")?.({ payload: { reason: "configdelete", configId: "a" } });
    expect(model.items.value[0].runConfigName).toBeNull();
    model.patch("0", { maxConcurrentDownloads: 3 });
    expect(model.items.value[0].maxConcurrentDownloads).toBe(3);
    expect(pathqlAll).not.toHaveBeenCalled();
  });

  it("写操作 refresh 请求当前累计窗口并从结果更新 total，不重置已加载页", async () => {
    pathqlAll.mockResolvedValue([rows(), 45]);
    const { model } = fixture();
    model.start();
    await flushPromises();
    pathqlAll.mockResolvedValueOnce([rows(40), 45]);
    model.loadMore();
    await flushPromises();
    const remaining = rows(40).slice(1);
    pathqlAll.mockResolvedValueOnce([remaining, 44]);
    model.refresh();
    expect(pathqlAll.mock.calls.at(-1)?.[0][0].path).toBe("tasks://x40x/1");
    expect(model.total.value).toBe(45);
    await flushPromises();
    expect(model.items.value).toHaveLength(39);
    expect(model.total.value).toBe(44);
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
    emit({ type: "TaskAdded", task: { id: "new" } });
    model.refresh();
    pending.resolve([rows(), 45]);
    await flushPromises();
    expect(pathqlAll).toHaveBeenCalledTimes(1);
    expect(model.items.value).toEqual([]);
    expect(model.total.value).toBe(0);
    expect(model.hasMore.value).toBe(false);
  });
});
