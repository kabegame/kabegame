// @vitest-environment happy-dom
import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import type { Plugin } from "@/stores/plugins";
import {
  useRecommendedPresets,
  filterRecommendedPresets,
  recommendedFacetCounts,
  type RecommendedPresetQuery,
} from "./recommendedPresets";
import { pluginResourceBase } from "./pluginFiles";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const pathqlFetch = vi.hoisted(() => vi.fn());
vi.mock("@/api", () => ({
  listen: vi.fn((event, handler) => {
    listeners.set(event, handler);
    return Promise.resolve(() => {
      if (listeners.get(event) === handler) listeners.delete(event);
    });
  }),
}));
vi.mock("@/services/pathql", () => ({ pathqlFetch, pathqlAll: vi.fn() }));
vi.mock("@/services/albums", () => ({ FAVORITE_ALBUM_ID: "favorite" }));
vi.mock("@/stores/plugins", () => ({ usePluginStore: () => ({ visiblePlugins: [] }) }));
const plugin: Plugin = {
  id: "test",
  name: {},
  description: {},
  version: "1.0.0",
  baseUrl: "https://example.test",
  sizeBytes: 0,
  config: {},
  packageJson: { kbRecommendedConfigs: ["configs/a.json", "configs/b.json"] },
};
const preset = (filename: string, isImported = false) => ({ pluginId: "test", filename, name: filename, isImported });
const rows = (isImported = false) =>
  ["a", "b"].map((name) => ({ ...preset(`${name}.json`, isImported), path: `configs/${name}.json` }));
const cleanups: (() => void)[] = [];
function start(plugins = ref([plugin]), enabled = ref(true)) {
  const scope = effectScope();
  cleanups.push(() => scope.stop());
  return scope.run(() => useRecommendedPresets(plugins, enabled))!;
}
function changed(pluginId: string, changes: Record<string, unknown>) {
  listeners.get("plugin-changed")?.({ payload: { pluginId, changes } });
}
beforeEach(() => {
  pathqlFetch.mockReset().mockResolvedValue(rows());
});
afterEach(async () => {
  cleanups.splice(0).forEach((dispose) => dispose());
  await flushPromises();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("推荐配置观察方", () => {
  it("三种来源逐段编码，provider 与推荐共用来源基址", () => {
    const p = { ...plugin, id: "a/b", version: "1 2" };
    expect(pluginResourceBase(p)).toBe("plugin://installed/a%2Fb/1%202");
    expect(pluginResourceBase({ ...p, fileOrigin: { kind: "store", sourceId: "s/a" } })).toBe(
      "plugin://byStore/s%2Fa/a%2Fb/1%202",
    );
    expect(pluginResourceBase({ ...p, fileOrigin: { kind: "preview", token: "t/a" } })).toBe(
      "plugin://byPreview/t%2Fa/a%2Fb/1%202",
    );
  });
  it("启用时先按声明顺序占位，每个来源只请求一次并按 path 落地", async () => {
    let finish!: (value: unknown) => void;
    pathqlFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const plugins = ref([plugin]);
    const enabled = ref(false);
    const state = start(plugins, enabled);
    expect(state.entries.value).toEqual([]);
    expect(pathqlFetch).not.toHaveBeenCalled();
    enabled.value = true;
    await nextTick();
    expect(state.entries.value.map((e) => e.preset)).toEqual([null, null]);
    expect(pathqlFetch).toHaveBeenCalledExactlyOnceWith("plugin://installed/test/1.0.0/recommended");
    finish(rows().reverse());
    await flushPromises();
    expect(state.presets.value.map((p) => p.filename)).toEqual(["a.json", "b.json"]);
    expect(state.presets.value[0].baseUrl).toBe(plugin.baseUrl);
    plugins.value = [
      plugin,
      { ...plugin, fileOrigin: { kind: "store", sourceId: "s" } },
      { ...plugin, fileOrigin: { kind: "preview", token: "t" } },
    ];
    await flushPromises();
    expect(pathqlFetch.mock.calls.map(([key]) => key)).toEqual([
      "plugin://installed/test/1.0.0/recommended",
      "plugin://byStore/s/test/1.0.0/recommended",
      "plugin://byPreview/t/test/1.0.0/recommended",
    ]);
    expect(new Set(state.entries.value.map((e) => e.key)).size).toBe(6);
    enabled.value = false;
    await nextTick();
    state.refresh();
    changed("test", { version: "2" });
    expect(state.entries.value).toEqual([]);
    expect(pathqlFetch).toHaveBeenCalledTimes(3);
  });
  it("只对本插件的 version 或 recommendedConfigs 刷新，核心合并窗口", async () => {
    vi.useFakeTimers();
    const state = start();
    await flushPromises();
    changed("other", { version: "2" });
    changed("test", { name: "renamed" });
    changed("test", {});
    await vi.advanceTimersByTimeAsync(500);
    expect(pathqlFetch).toHaveBeenCalledTimes(1);
    pathqlFetch.mockResolvedValue(rows(true));
    changed("test", { recommendedConfigs: { "configs/a.json": { imported: true } } });
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
    expect(state.presets.value[0].isImported).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    changed("test", { version: "1.0.0" });
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(3);
  });
  it("失败保留上一份内容，首次失败移除占位，刷新可恢复", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = start();
    await flushPromises();
    pathqlFetch.mockRejectedValue(new Error("read failed"));
    state.refresh();
    await flushPromises();
    expect(state.presets.value.map((p) => p.filename)).toEqual(["a.json", "b.json"]);
    const second = start(ref([{ ...plugin, version: "2" }]));
    await flushPromises();
    expect(second.entries.value).toEqual([]);
    pathqlFetch.mockResolvedValue(rows());
    second.refresh();
    await flushPromises();
    expect(second.presets.value).toHaveLength(2);
  });
  it("版本切换退订旧 key，晚到结果不覆盖新版本", async () => {
    let finish!: (value: unknown) => void;
    pathqlFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const plugins = ref([plugin]);
    const state = start(plugins);
    plugins.value = [{ ...plugin, version: "2" }];
    await flushPromises();
    expect(pathqlFetch).toHaveBeenCalledTimes(2);
    expect(state.entries.value.every((e) => e.key.startsWith("plugin://installed/test/2/recommended/"))).toBe(true);
    finish(rows(true));
    await flushPromises();
    expect(state.presets.value[0].isImported).toBe(false);
  });
  it("过滤与 facet 都使用宿主返回的导入态", () => {
    const presets = [preset("a.json", false), preset("b.json", true)].map((item) => ({
      ...item,
      baseUrl: "",
      isDryRun: false,
    }));
    const query: RecommendedPresetQuery = {
      search: "",
      plugin: null,
      mode: null,
      imported: "yes",
      sort: "name",
      dir: "asc",
    };
    const title = (p: { filename: string }) => p.filename;
    expect(filterRecommendedPresets(presets, query, title, () => "").map((p) => p.filename)).toEqual(["b.json"]);
    expect(recommendedFacetCounts(presets, query, "imported", title, () => "")).toEqual({ yes: 1, no: 1 });
  });
});
