import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import type { Plugin } from "@/stores/plugins";
import {
  fetchPluginText,
  invalidatePluginFiles,
  resolvePluginLocalePath,
  usePluginDescriptionTemplate,
} from "./pluginFiles";

vi.mock("@/utils/fileUrl", () => ({
  initHttpServerBaseUrl: vi.fn().mockResolvedValue(undefined),
  pluginFileUrl: (plugin: Plugin, path: string) =>
    `${plugin.id}/${plugin.version}/${JSON.stringify(plugin.fileOrigin)}/${path}`,
}));
const plugin: Plugin = {
  id: "test",
  name: {},
  description: {},
  version: "1.0.0",
  baseUrl: "",
  sizeBytes: 0,
  config: {},
  packageJson: { kbDescriptionTemplate: "description.ejs" },
};
const fetchMock = vi.fn();
beforeEach(() => {
  invalidatePluginFiles(plugin.id);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const response = (text: string) => new Response(text, { status: 200 });

describe("插件文本请求缓存", () => {
  it("同 URL 并发请求共用一次 fetch，版本与来源隔离", async () => {
    fetchMock.mockResolvedValue(response("text"));
    expect(await Promise.all([fetchPluginText(plugin, "a.md"), fetchPluginText(plugin, "a.md")])).toEqual([
      "text",
      "text",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValue(response("new"));
    expect(await fetchPluginText({ ...plugin, version: "2.0.0" }, "a.md")).toBe("new");
    fetchMock.mockResolvedValue(response("store"));
    expect(await fetchPluginText({ ...plugin, fileOrigin: { kind: "store", sourceId: "s" } }, "a.md")).toBe("store");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("失败移出缓存，安装更新失效后可重新读取", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(response("ok"));
    await expect(fetchPluginText(plugin, "a.md")).rejects.toThrow("404");
    expect(await fetchPluginText(plugin, "a.md")).toBe("ok");
    invalidatePluginFiles(plugin.id);
    fetchMock.mockResolvedValueOnce(response("updated"));
    expect(await fetchPluginText(plugin, "a.md")).toBe("updated");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("语言路径采用 locale → default 回落", () => {
    const paths = { default: "README.md", zh: "中文.md" };
    expect(resolvePluginLocalePath(paths, "zh")).toBe("中文.md");
    expect(resolvePluginLocalePath(paths, "ja")).toBe("README.md");
    expect(resolvePluginLocalePath(null, "zh")).toBe("");
  });
  it("模板晚到不能覆盖后来选择的插件；加载期间保持空文本", async () => {
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(response("current"));
    const selected = ref<Plugin | null>(plugin);
    const scope = effectScope();
    const state = scope.run(() => usePluginDescriptionTemplate(selected))!;
    expect(state.loading.value).toBe(true);
    expect(state.text.value).toBe("");
    await nextTick();
    selected.value = { ...plugin, version: "2.0.0" };
    await nextTick();
    await vi.waitFor(() => expect(state.text.value).toBe("current"));
    finish(response("stale"));
    await nextTick();
    expect(state.text.value).toBe("current");
    scope.stop();
  });
});
