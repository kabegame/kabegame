import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { usePluginStore, type Plugin } from "./plugins";
import { invalidatePluginFiles } from "@/services/pluginFiles";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));
vi.mock("../api", () => ({
  invoke: mocks.invoke,
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@/services/pluginFiles", () => ({ invalidatePluginFiles: vi.fn() }));

const plugin: Plugin = {
  id: "a",
  version: "1.0",
  name: { default: "插件" },
  description: {},
  baseUrl: "https://example.test",
  sizeBytes: 1,
  config: {},
};

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.listeners.clear();
  vi.clearAllMocks();
  mocks.invoke.mockResolvedValue([{ ...plugin }]);
});

describe("plugin-changed", () => {
  it("有 version 时合并插件并更新当前详情、清除详情缓存", async () => {
    const store = usePluginStore();
    await store.loadPlugins();
    store.setActivePlugin(store.plugins[0]);
    store.setCachedPluginDetail("installed/a", store.plugins[0]);
    vi.mocked(invalidatePluginFiles).mockClear();
    mocks.listeners.get("plugin-changed")!({
      payload: {
        pluginId: "a",
        changes: { version: "2.0", description: { default: "新描述" } },
      },
    });
    expect(store.plugins).toEqual([{ ...plugin, version: "2.0", description: { default: "新描述" } }]);
    expect(store.activePlugin).toEqual(store.plugins[0]);
    expect(store.getCachedPluginDetail("installed/a")).toBeUndefined();
    expect(invalidatePluginFiles).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("没有 version 的导入态 patch 不改变插件或缓存", async () => {
    const store = usePluginStore();
    await store.loadPlugins();
    store.setCachedPluginDetail("installed/a", store.plugins[0]);
    vi.mocked(invalidatePluginFiles).mockClear();
    mocks.listeners.get("plugin-changed")!({
      payload: {
        pluginId: "a",
        changes: { recommendedConfigs: { "a.json": { imported: true } } },
      },
    });
    expect(store.plugins).toEqual([plugin]);
    expect(store.getCachedPluginDetail("installed/a")).toEqual(plugin);
    expect(invalidatePluginFiles).not.toHaveBeenCalled();
  });

  it("覆盖安装完整 JSON 可补入尚未加载的插件，同版本仍更新内容", async () => {
    const store = usePluginStore();
    await store.loadPlugins();
    const changed = mocks.listeners.get("plugin-changed")!;
    changed({ payload: { pluginId: "b", changes: { ...plugin, id: "b" } } });
    changed({ payload: { pluginId: "a", changes: { ...plugin, name: { default: "同版本重装" } } } });
    expect(store.plugins.map((item) => item.id)).toEqual(["a", "b"]);
    expect(store.plugins[0].name).toEqual({ default: "同版本重装" });
  });
});
