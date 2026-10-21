// @vitest-environment happy-dom
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/api";
import { subscribeChanges } from "./dataChangeHub";
import { registerRunConfigView, registerRecommendedImportStates, writeRunConfig } from "./runConfigWrites";
import { usePagedRunConfigs } from "@/composables/usePagedRunConfigs";
import { pathqlView, pathqlCount } from "./pathql";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@/api", () => ({ invoke: vi.fn() }));
vi.mock("@/api/rpc", () => ({
  listen: vi.fn((event, handler) => {
    listeners.set(event, handler);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@/debugIngest", () => ({ sendDebugEvent: vi.fn() }));
vi.mock("./pathql", () => ({ pathqlView: vi.fn(), pathqlCount: vi.fn(), pathqlFetch: vi.fn(), pathqlList: vi.fn() }));
vi.mock("./tasks", () => ({ subscribeTaskEvents: () => () => {}, normalizeTaskRow: vi.fn() }));
vi.mock("./albums", () => ({ FAVORITE_ALBUM_ID: "favorite" }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.clearAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function emit(seq: number, configId = "a") {
  listeners.get("auto-config-change")!({ payload: { seq, configId, reason: "configchange" } });
}
function result(seq: number) {
  return {
    configId: "a",
    reason: "configchange",
    seq,
    config: { id: "a" },
    view: { rows: [{ id: "replacement" }], seq },
    recommended: [],
    recommendedSeq: seq,
  };
}

describe("配置主动快照与事件补位", () => {
  it("事件先到时缓冲，先应用快照和导入态，再发布本地结果；后续同序号事件去重", async () => {
    const batch = vi.fn();
    cleanups.push(subscribeChanges({ waitMs: 0, filter: (b) => b.runConfigs.size > 0, onBatch: batch }));
    const apply = vi.fn();
    const imported = vi.fn();
    cleanups.push(registerRunConfigView({ key: () => "run_configs://x20x/1", apply }));
    cleanups.push(registerRecommendedImportStates({ requests: () => [], apply: imported }));
    const response = deferred<ReturnType<typeof result>>();
    vi.mocked(invoke).mockReturnValueOnce(response.promise);
    const writing = writeRunConfig("update_run_config", { config: { id: "a" } });
    emit(100);
    expect(batch).not.toHaveBeenCalled();
    response.resolve(result(100));
    await writing;
    expect(apply).toHaveBeenCalledWith(result(100).view);
    expect(imported).toHaveBeenCalledWith([], 100);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(batch.mock.invocationCallOrder[0]);
    expect(imported.mock.invocationCallOrder[0]).toBeLessThan(batch.mock.invocationCallOrder[0]);
    emit(100);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("路径切换拒绝旧视图；写失败仍放行外部事件", async () => {
    const batch = vi.fn();
    cleanups.push(subscribeChanges({ waitMs: 0, filter: (b) => b.runConfigs.size > 0, onBatch: batch }));
    let key = "run_configs://name/old/x20x/1";
    const apply = vi.fn();
    cleanups.push(registerRunConfigView({ key: () => key, apply }));
    const response = deferred<ReturnType<typeof result>>();
    vi.mocked(invoke).mockReturnValueOnce(response.promise);
    const writing = writeRunConfig("update_run_config", {});
    key = "run_configs://name/new/x20x/1";
    response.resolve(result(110));
    await writing;
    expect(apply).not.toHaveBeenCalled();
    await flushPromises();
    const failed = deferred<ReturnType<typeof result>>();
    vi.mocked(invoke).mockReturnValueOnce(failed.promise);
    const rejected = expect(writeRunConfig("delete_run_config", {})).rejects.toThrow("write failed");
    emit(111, "external");
    expect(batch).toHaveBeenCalledTimes(1);
    failed.reject(new Error("write failed"));
    await rejected;
    await flushPromises();
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it("响应覆盖同配置的旧事件，仍放行其它配置的外部变更", async () => {
    const batches: { ids: string[]; seq: number }[] = [];
    cleanups.push(
      subscribeChanges({
        waitMs: 0,
        filter: (b) => b.runConfigs.size > 0,
        onBatch: (b) => {
          batches.push({ ids: [...b.runConfigs.keys()], seq: b.maxSeq });
        },
      }),
    );
    const response = deferred<ReturnType<typeof result>>();
    vi.mocked(invoke).mockReturnValueOnce(response.promise);
    const writing = writeRunConfig("update_run_config", {});
    emit(119); // 调度器在命令内较早发出的同配置事件。
    emit(120, "external");
    response.resolve(result(121));
    await writing;
    await flushPromises();
    expect(batches).toEqual([
      { ids: ["a"], seq: 121 },
      { ids: ["external"], seq: 120 },
    ]);
  });

  it("按后端快照替换累计分页窗口；自身事件只补计数，外部事件补行与计数", async () => {
    let state!: ReturnType<typeof usePagedRunConfigs>;
    const base = ref("sort/created/desc/");
    const row = (id: string) => ({ id, name: id, pluginId: "test", createdAt: 1 });
    vi.mocked(pathqlView)
      .mockResolvedValueOnce({ rows: Array.from({ length: 20 }, (_, i) => row(String(i))), seq: 200 })
      .mockResolvedValueOnce({ rows: Array.from({ length: 40 }, (_, i) => row(String(i))), seq: 200 });
    vi.mocked(pathqlCount).mockResolvedValue({ total: 45, seq: 200 });
    const wrapper = mount(
      defineComponent({
        setup() {
          state = usePagedRunConfigs({
            basePath: () => base.value,
            countPath: () => "",
            matches: () => true,
            sort: () => ({ key: "created", dir: "desc" }),
          });
          return () => null;
        },
      }),
    );
    cleanups.push(() => wrapper.unmount());
    await state.start();
    await state.loadMore();
    expect(pathqlView).toHaveBeenLastCalledWith("run_configs://sort/created/desc/x40x/1");
    expect(pathqlCount).toHaveBeenCalledTimes(1);
    const response = { ...result(201), view: { rows: [row("authoritative")], seq: 201 } };
    vi.mocked(invoke).mockResolvedValueOnce(response);
    vi.mocked(pathqlCount).mockResolvedValue({ total: 44, seq: 201 });
    await writeRunConfig("delete_run_config", { configId: "a" });
    await flushPromises();
    expect(state.items.value.map((row) => row.id)).toEqual(["authoritative"]);
    expect(state.total.value).toBe(44);
    expect(pathqlView).toHaveBeenCalledTimes(2);
    expect(vi.mocked(invoke).mock.calls.at(-1)![1]).toMatchObject({ view: "run_configs://sort/created/desc/x40x/1" });
    vi.mocked(pathqlView).mockResolvedValueOnce({ rows: [row("external")], seq: 202 });
    vi.mocked(pathqlCount).mockResolvedValue({ total: 43, seq: 202 });
    emit(202, "external");
    await flushPromises();
    expect(state.items.value.map((row) => row.id)).toEqual(["external"]);
    expect(state.total.value).toBe(43);
  });
});
