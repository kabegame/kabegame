import { afterEach, describe, expect, it, vi } from "vitest";

type FileUrlModule = typeof import("./fileUrl");
const BASE = "http://127.0.0.1:41619";

async function loadModule(opts: { isWeb?: boolean; isAndroid?: boolean } = {}) {
  vi.resetModules();
  const invoke = vi.fn().mockResolvedValue(BASE);
  vi.doMock("../env", () => ({ IS_WEB: opts.isWeb ?? false, IS_ANDROID: opts.isAndroid ?? false }));
  vi.doMock("../api", () => ({ invoke }));
  const mod: FileUrlModule = await import("./fileUrl");
  return { mod, invoke };
}

afterEach(() => {
  vi.doUnmock("../env");
  vi.doUnmock("../api");
  vi.unstubAllEnvs();
});

describe("桌面 file URL", () => {
  it("启动不请求 HTTP 基址，原图与缩略图可直接读取", async () => {
    const { mod, invoke } = await loadModule();
    await mod.initHttpServerBaseUrl();
    expect(invoke).not.toHaveBeenCalled();
    expect(mod.fileToUrl("C:\\Users\\cm\\a b.png")).toBe("file:///C:/Users/cm/a%20b.png");
    expect(mod.thumbnailToUrl("/home/cm/t.png")).toBe("file:///home/cm/t.png");
    expect(mod.compatibleToUrl("D:/video/a.mp4")).toBe("file:///D:/video/a.mp4");
    expect(mod.pluginFileUrl({ id: "p", version: "1" }, "a.png")).toBe("");
  });

  it("UNC、扩展路径与保留字符按段编码", async () => {
    const { mod } = await loadModule();
    expect(mod.pathToFileUrl("\\\\server\\share\\a b.png")).toBe("file://server/share/a%20b.png");
    expect(mod.pathToFileUrl("\\\\?\\C:\\a#b?.png")).toBe("file:///C:/a%23b%3F.png");
    expect(mod.fileNameFromUrlOrPath("file:///C:/a%20b.png")).toBe("a b.png");
  });
});

describe("Android / Web HTTP 路径", () => {
  it("Android 保留本地媒体和插件端点", async () => {
    const { mod, invoke } = await loadModule({ isAndroid: true });
    await mod.initHttpServerBaseUrl();
    expect(invoke).toHaveBeenCalledWith("get_http_server_base_url");
    expect(mod.fileToUrl("/a.png")).toBe(`${BASE}/file/a.png`);
    expect(mod.pluginFileUrl({ id: "p", version: "1" }, "docs/a b.md")).toBe(`${BASE}/plugin_file/p/docs/a%20b.md?v=1`);
  });

  it("Web 使用 VITE_API_ROOT 与来源参数", async () => {
    vi.stubEnv("VITE_API_ROOT", "/api/");
    const { mod, invoke } = await loadModule({ isWeb: true });
    await mod.initHttpServerBaseUrl();
    expect(invoke).not.toHaveBeenCalled();
    expect(mod.compatibleToUrl("/c.mp4")).toBe("/api/compatible/c.mp4");
    expect(mod.pluginFileUrl({ id: "p", version: "2", fileOrigin: { kind: "store", sourceId: "a&b" } }, "a.json")).toBe(
      "/api/plugin_file/p/a.json?v=2&source=a%26b",
    );
  });
});
