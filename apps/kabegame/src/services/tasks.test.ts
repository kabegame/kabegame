import { effectScope } from "vue";
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  pathqlCount: vi.fn(),
  pathqlFetch: vi.fn(),
  pathqlList: vi.fn(),
}));

vi.mock("@/api", () => ({ listen: mocks.listen }));
vi.mock("@/services/pathql", () => ({
  pathqlCount: mocks.pathqlCount,
  pathqlFetch: mocks.pathqlFetch,
  pathqlList: mocks.pathqlList,
}));

import { usePagedTaskList } from "@/composables/usePagedTaskList";
import { normalizeTaskRow, taskSearchPath } from "./tasks";

function rawTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    plugin_id: "plugin/a",
    status: "running",
    progress: 10,
    start_time: 100,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("任务 PathQL 服务", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.listen.mockReset().mockImplementation(async (name, handler) => {
      mocks.listeners.set(name, handler);
      return () => mocks.listeners.delete(name);
    });
    mocks.pathqlCount.mockReset().mockResolvedValue({ total: 1 });
    mocks.pathqlFetch.mockReset().mockResolvedValue([rawTask("task-1")]);
    mocks.pathqlList.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("为插件精确命中与文本搜索生成编码后的 ~any 路径", () => {
    expect(taskSearchPath("作者 / 标签", ["plugin/a", "plugin/a", "空 格"])).toBe(
      "~any/plugin/plugin\\/a/~or/plugin/空 格/~or/plugin_search/作者 \\/ 标签/~end/",
    );
  });

  it("把 PathQL 的 JSON 字符串列与 SQLite 0/1 规范化为任务行", () => {
    expect(
      normalizeTaskRow(
        rawTask("task-1", {
          user_config: '{"page":2}',
          http_headers: '{"authorization":"token"}',
          is_dry_run: 1,
          max_concurrent_downloads: null,
          run_config_name: "每日抓取",
        }),
      ),
    ).toMatchObject({
      id: "task-1",
      pluginId: "plugin/a",
      userConfig: { page: 2 },
      httpHeaders: { authorization: "token" },
      isDryRun: true,
      maxConcurrentDownloads: null,
      runConfigName: "每日抓取",
    });
  });

  it("幂等合并任务事件，并在 stop 后丢弃在途的新增任务查询", async () => {
    const scope = effectScope();
    const pager = scope.run(() =>
      usePagedTaskList({
        basePath: () => "",
        matches: () => true,
      }),
    )!;

    await pager.start();
    const taskListener = mocks.listeners.get("tasks-change")!;
    taskListener({
      payload: {
        type: "TaskChanged",
        taskId: "task-1",
        diff: { progress: 80, success_count: 3 },
      },
    });
    await flushPromises();
    expect(pager.items.value).toHaveLength(1);
    expect(pager.items.value[0]).toMatchObject({ progress: 80, successCount: 3 });

    const pending = deferred<Record<string, unknown>[]>();
    mocks.pathqlFetch.mockImplementation((path: string) => {
      if (path === "tasks://id_task-2") return pending.promise;
      return Promise.resolve([rawTask("task-1")]);
    });
    taskListener({ payload: { type: "TaskAdded", task: { id: "task-2" } } });
    pager.stop();
    pending.resolve([rawTask("task-2", { start_time: 200 })]);
    await flushPromises();

    expect(pager.items.value).toEqual([]);
    expect(pager.total.value).toBe(0);
    scope.stop();
  });
});
