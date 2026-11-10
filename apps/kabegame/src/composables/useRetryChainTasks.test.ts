// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryChainSlots, useRetryChainTasks } from "./useRetryChainTasks";
import { pathqlRequest$, type PathqlRequest } from "@/services/kbEvents";
import { normalizeTaskRow } from "@/services/tasks";
import type { CrawlTask } from "@/stores/crawler";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn<(path: string) => Promise<Record<string, unknown>[]>>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      if (listeners.get(name) === handler) listeners.delete(name);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlAll: vi.fn(), pathqlFetch }));
vi.mock("@/services/runConfigs", () => ({ fetchRunConfig: vi.fn() }));

const row = (id: string, attempt: number, root = "root") => ({
  id,
  plugin_id: "test",
  status: "failed",
  progress: 10,
  start_time: attempt + 1,
  retry_count: 3,
  retry_attempt: attempt,
  retry_root_id: root,
});
const task = (id: string, attempt: number) => normalizeTaskRow(row(id, attempt)) as CrawlTask;

const cleanups: (() => void)[] = [];
beforeEach(() => pathqlFetch.mockReset());
afterEach(async () => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await flushPromises();
  vi.useRealTimers();
});

function fixture() {
  const root = ref<string | null>(null);
  const requests: PathqlRequest[] = [];
  const subscription = pathqlRequest$.subscribe((request) => requests.push(request));
  cleanups.push(() => subscription.unsubscribe());
  let model!: ReturnType<typeof useRetryChainTasks>;
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useRetryChainTasks(() => root.value);
        return () => null;
      },
    }),
  );
  cleanups.push(() => wrapper.unmount());
  return { model, root, requests };
}
const emit = (payload: unknown) => listeners.get("tasks-change")?.({ payload });

describe("retryChainSlots", () => {
  it("按第几次从新到旧铺满，缺的那几次给占位", () => {
    const slots = retryChainSlots([task("r3", 3), task("r1", 1)]);
    expect(slots.map((slot) => [slot.attempt, slot.task?.id ?? null])).toEqual([
      [3, "r3"],
      [2, null],
      [1, "r1"],
      [0, null],
    ]);
  });

  it("没有行时不给占位；只有原始任务时一格", () => {
    expect(retryChainSlots([])).toEqual([]);
    expect(retryChainSlots([task("root", 0)]).map((slot) => slot.task?.id)).toEqual(["root"]);
  });
});

describe("useRetryChainTasks", () => {
  it("rootId 为空时不观察；打开后请求 tasks://retry_root/<id>，关闭清空", async () => {
    pathqlFetch.mockResolvedValue([row("r1", 1), row("root", 0)]);
    const { model, root, requests } = fixture();
    await flushPromises();
    expect(requests).toEqual([]);
    root.value = "root";
    await flushPromises();
    expect(requests).toEqual([["rows", "tasks://retry_root/root"]]);
    expect(model.slots.value.map((slot) => slot.task?.id)).toEqual(["r1", "root"]);
    root.value = null;
    await flushPromises();
    expect(model.items.value).toEqual([]);
  });

  it("只有本链的新增与已持有行的删除才刷新，字段变化就地补丁", async () => {
    vi.useFakeTimers();
    pathqlFetch.mockResolvedValue([row("root", 0)]);
    const { model, root } = fixture();
    root.value = "root";
    await flushPromises();
    pathqlFetch.mockClear();

    emit({ type: "TaskAdded", task: { id: "x", pluginId: "test", retryRootId: "other" } });
    emit({ type: "TaskDeleted", taskId: "not-held" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).not.toHaveBeenCalled();

    emit({ type: "TaskChanged", taskId: "root", diff: { status: "completed" } });
    expect(model.items.value[0].status).toBe("completed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).not.toHaveBeenCalled();

    pathqlFetch.mockResolvedValue([row("r1", 1), row("root", 0)]);
    emit({ type: "TaskAdded", task: { id: "r1", pluginId: "test", retryRootId: "root", retryAttempt: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    expect(model.items.value.map((t) => t.id)).toEqual(["r1", "root"]);

    pathqlFetch.mockClear();
    pathqlFetch.mockResolvedValue([row("r1", 1)]);
    emit({ type: "TaskDeleted", taskId: "root" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    expect(model.slots.value.map((slot) => [slot.attempt, slot.task?.id ?? null])).toEqual([
      [1, "r1"],
      [0, null],
    ]);
  });
});
