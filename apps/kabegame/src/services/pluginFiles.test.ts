import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@/stores/plugins";
import { fetchPluginText, invalidatePluginFiles, pluginAssetUrl, pluginFileKey } from "./pluginFiles";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/env", () => ({ IS_WEB: false, IS_ANDROID: false }));
vi.mock("@/api", () => ({ invoke }));
vi.mock("@/composables/useImageTypes", () => ({
  useImageTypes: () => ({ load: async () => {}, getMimeType: () => "image/png" }),
}));

const plugin = {
  id: "test",
  version: "1.0.0",
  name: {},
  description: {},
  baseUrl: "",
  sizeBytes: 0,
  config: {},
  packageJson: {},
} as Plugin;
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();

beforeEach(() => {
  invalidatePluginFiles(plugin.id);
  invoke.mockReset();
  createObjectURL.mockReset().mockReturnValue("blob:http://localhost/one");
  revokeObjectURL.mockReset();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
});
afterEach(() => vi.unstubAllGlobals());

describe("桌面插件文件", () => {
  it("原始 IPC 字节解码为文本，按坐标缓存并隔离来源", async () => {
    invoke.mockResolvedValueOnce(bytes("中文"));
    expect(await Promise.all([fetchPluginText(plugin, "a.md"), fetchPluginText(plugin, "a.md")])).toEqual([
      "中文",
      "中文",
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("read_plugin_file", {
      pluginId: "test",
      version: "1.0.0",
      path: "a.md",
      source: null,
      preview: null,
    });
    expect(pluginFileKey(plugin, "a.md")).not.toBe(pluginFileKey({ ...plugin, version: "2" }, "a.md"));
    expect(pluginFileKey(plugin, "a.md")).not.toBe(
      pluginFileKey({ ...plugin, fileOrigin: { kind: "store", sourceId: "s" } }, "a.md"),
    );
  });

  it("blob URL 命中缓存，失效后 revoke 并重新读取", async () => {
    invoke.mockResolvedValue(bytes("image"));
    expect(await pluginAssetUrl(plugin, "banner.png")).toBe("blob:http://localhost/one");
    expect(await pluginAssetUrl(plugin, "banner.png")).toBe("blob:http://localhost/one");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    invalidatePluginFiles(plugin.id);
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/one"));
    await pluginAssetUrl(plugin, "banner.png");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("读取失败后移出缓存", async () => {
    invoke.mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce(bytes("ok"));
    await expect(fetchPluginText(plugin, "a.md")).rejects.toThrow("missing");
    expect(await fetchPluginText(plugin, "a.md")).toBe("ok");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
