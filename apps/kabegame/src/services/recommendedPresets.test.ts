import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import type { Plugin } from "@/stores/plugins";
import {
  useRecommendedPresets,
  filterRecommendedPresets,
  recommendedFacetCounts,
  type RecommendedPresetQuery,
} from "./recommendedPresets";
import { fetchRecommendedConfig } from "./pluginFiles";

const hooks = vi.hoisted(() => ({ handler: (() => {}) as () => void, dispose: vi.fn() }));
vi.mock("./pluginFiles", () => ({
  recommendedConfigPaths: (plugin: Plugin) => plugin.packageJson?.kbRecommendedConfigs ?? [],
  fetchRecommendedConfig: vi.fn(),
}));
vi.mock("@/services/runConfigs", () => ({
  subscribeRunConfigEvents: (handler: () => void) => {
    hooks.handler = handler;
    return hooks.dispose;
  },
}));
vi.mock("@/stores/plugins", () => ({ usePluginStore: () => ({ visiblePlugins: [] }) }));
const plugin: Plugin = {
  id: "test",
  name: {},
  description: {},
  version: "1.0.0",
  baseUrl: "",
  sizeBytes: 0,
  config: {},
  packageJson: { kbRecommendedConfigs: ["configs/a.json", "configs/b.json"] },
};
const preset = (filename: string, isImported = false) => ({ pluginId: "test", filename, name: filename, isImported });
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("推荐配置渐进加载", () => {
  it("只在启用时请求，先发布占位，乱序完成仍替换原位置", async () => {
    const finish = new Map<string, (value: unknown) => void>();
    vi.mocked(fetchRecommendedConfig).mockImplementation(
      (_, path) => new Promise((resolve) => finish.set(path, resolve)),
    );
    const scope = effectScope();
    const enabled = ref(false);
    const state = scope.run(() => useRecommendedPresets(ref([plugin]), enabled))!;
    expect(state.entries.value.map((entry) => entry.preset)).toEqual([null, null]);
    expect(fetchRecommendedConfig).not.toHaveBeenCalled();
    enabled.value = true;
    await nextTick();
    finish.get("configs/b.json")!(preset("b.json"));
    await nextTick();
    expect(state.entries.value.map((entry) => entry.preset?.filename ?? null)).toEqual([null, "b.json"]);
    finish.get("configs/a.json")!(preset("a.json"));
    await nextTick();
    expect(state.presets.value.map((entry) => entry.filename)).toEqual(["a.json", "b.json"]);
    scope.stop();
    expect(hooks.dispose).toHaveBeenCalled();
  });
  it("配置事件防抖刷新 isImported，插件切换后丢弃旧结果", async () => {
    vi.useFakeTimers();
    const fetcher = vi.mocked(fetchRecommendedConfig);
    fetcher.mockResolvedValue(preset("a.json", false));
    const plugins = ref([{ ...plugin, packageJson: { kbRecommendedConfigs: ["configs/a.json"] } }]);
    const scope = effectScope();
    const state = scope.run(() => useRecommendedPresets(plugins))!;
    await nextTick();
    expect(state.presets.value[0].isImported).toBe(false);
    fetcher.mockResolvedValue(preset("a.json", true));
    hooks.handler();
    hooks.handler();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.presets.value[0].isImported).toBe(true);
    let finish!: (value: unknown) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = state.refresh();
    plugins.value = [];
    await nextTick();
    finish(preset("old.json"));
    await refresh;
    expect(state.entries.value).toEqual([]);
    scope.stop();
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
