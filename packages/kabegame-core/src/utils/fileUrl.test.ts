import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "http://127.0.0.1:41619";

/** 取自真实图库的恶劣文件名：中文 + 书名号 + 省略号 + 括号。 */
const CJK_PATH =
  "/home/cm/Pictures/Kabegame/【约稿】这一脚下去你可能会……(2).png";

type FileUrlModule = typeof import("./fileUrl");

/**
 * 每个用例都拿一份全新模块，原因有两个：
 * - `httpServerBaseUrl` 是模块级单例，一旦初始化就不再变，跨用例复用会串味；
 * - `IS_WEB` 在真实构建里是编译期常量，只能在模块加载**之前**用 doMock 顶掉。
 */
async function loadModule(
  opts: { isWeb?: boolean; invoke?: () => Promise<unknown> } = {},
) {
  vi.resetModules();
  const invoke = vi.fn(opts.invoke ?? (() => Promise.resolve(BASE)));
  vi.doMock("../env", () => ({ IS_WEB: opts.isWeb ?? false }));
  vi.doMock("../api", () => ({ invoke }));
  const mod: FileUrlModule = await import("./fileUrl");
  return { mod, invoke };
}

/** 已完成初始化的桌面态模块——绝大多数用例的前置条件。 */
async function loadReady(base: string = BASE) {
  const { mod, invoke } = await loadModule({
    invoke: () => Promise.resolve(base),
  });
  await mod.initHttpServerBaseUrl();
  return { mod, invoke };
}

/**
 * 后端 `/download/{*path}` 通配路由解析的可执行副本，对应
 * `src-tauri/kabegame/src/http_server.rs` 的 `handle_download_path`：
 * 取 `/download/` 之后的整段 → 百分号解码 → Unix 补回前导斜杠。
 *
 * 它存在的意义是把前后端契约钉成测试。后端换了解析方式，这里必须同步改，
 * 否则下面那组往返用例会立刻变成谎言。
 */
function decodeLikeBackend(url: string): string {
  const marker = "/download/";
  const rest = url.slice(url.indexOf(marker) + marker.length);
  const decoded = rest.split("/").map(decodeURIComponent).join("/");
  return /^[A-Za-z]:/.test(decoded) ? decoded : `/${decoded}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../env");
  vi.doUnmock("../api");
});

describe("initHttpServerBaseUrl", () => {
  it("桌面态向后端要 base url，并去掉首尾空白", async () => {
    const { mod, invoke } = await loadModule({
      invoke: () => Promise.resolve(`  ${BASE}  `),
    });
    await mod.initHttpServerBaseUrl();

    expect(invoke).toHaveBeenCalledWith("get_http_server_base_url");
    expect(mod.fileToUrl("/a.png")).toBe(`${BASE}/file?path=%2Fa.png`);
  });

  it("后端调用失败时退化为空 base，而不是抛错", async () => {
    const { mod } = await loadModule({
      invoke: () => Promise.reject(new Error("ipc down")),
    });

    await expect(mod.initHttpServerBaseUrl()).resolves.toBeUndefined();
    // base 为空串时仍会拼出相对路径 URL，重点是不抛、不返回 undefined
    expect(mod.fileToUrl("/a.png")).toBe("/file?path=%2Fa.png");
  });

  it("幂等：重复调用不会再次访问后端", async () => {
    const { mod, invoke } = await loadReady();
    await mod.initHttpServerBaseUrl();
    await mod.initHttpServerBaseUrl();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("web 态用 VITE_API_ROOT，并去掉结尾斜杠", async () => {
    vi.stubEnv("VITE_API_ROOT", "https://cdn.example.com/");
    const { mod, invoke } = await loadModule({ isWeb: true });
    await mod.initHttpServerBaseUrl();

    expect(invoke).not.toHaveBeenCalled();
    expect(mod.fileToUrl("/a.png")).toBe(
      "https://cdn.example.com/file?path=%2Fa.png",
    );
  });

  it("web 态缺省 VITE_API_ROOT 时回落到同源", async () => {
    vi.stubEnv("VITE_API_ROOT", "");
    const { mod } = await loadModule({ isWeb: true });
    await mod.initHttpServerBaseUrl();

    expect(mod.fileToUrl("/a.png")).toBe("/file?path=%2Fa.png");
  });
});

describe("fileToUrl", () => {
  it("空值与纯空白返回空串", async () => {
    const { mod } = await loadReady();
    expect(mod.fileToUrl("")).toBe("");
    expect(mod.fileToUrl("   ")).toBe("");
  });

  it("已经是绝对 http(s) 地址时原样透传（web 的 CDN 直链）", async () => {
    const { mod } = await loadReady();
    const cdn = "https://cdn.example.com/img/a.png";
    expect(mod.fileToUrl(cdn)).toBe(cdn);
    expect(mod.fileToUrl("http://example.com/b.png")).toBe(
      "http://example.com/b.png",
    );
  });

  it("把路径整条编码进 query", async () => {
    const { mod } = await loadReady();
    expect(mod.fileToUrl(CJK_PATH)).toBe(
      `${BASE}/file?path=${encodeURIComponent(CJK_PATH)}`,
    );
  });

  it("base 尚未初始化时返回空串", async () => {
    const { mod } = await loadModule();
    expect(mod.fileToUrl("/a.png")).toBe("");
  });
});

describe("downloadToUrl", () => {
  it("把路径接在 /download 之后，且不产生双斜杠", async () => {
    const { mod } = await loadReady();
    expect(mod.downloadToUrl("/home/cm/Pictures/a.png")).toBe(
      `${BASE}/download/home/cm/Pictures/a.png`,
    );
  });

  it("保留 / 作为路径分隔符——绝不能整条编码", async () => {
    const { mod } = await loadReady();
    const url = mod.downloadToUrl(CJK_PATH);

    // 这是本文件最重要的一条断言。一旦有人把实现改成
    // `encodeURIComponent(整条路径)`，`/` 会变成 %2F，URL 退化成单段，
    // 文件名就不再是末段，下载方拿到的落地文件名会全错。
    expect(url).not.toContain("%2F");
    expect(url.startsWith(`${BASE}/download/home/cm/Pictures/Kabegame/`)).toBe(
      true,
    );
  });

  it("文件名保持为 URL 末段，解码后与原文件名逐字相等", async () => {
    const { mod } = await loadReady();
    const url = mod.downloadToUrl(CJK_PATH);
    const lastSegment = url.slice(url.lastIndexOf("/") + 1);

    expect(decodeURIComponent(lastSegment)).toBe(
      "【约稿】这一脚下去你可能会……(2).png",
    );
  });

  it("会破坏 URL 结构的字符被编码掉", async () => {
    const { mod } = await loadReady();
    const url = mod.downloadToUrl("/home/cm/a b#c?d.png");

    expect(url).not.toContain("#");
    expect(url).not.toContain("?");
    expect(url).not.toContain(" ");
    expect(url).toBe(`${BASE}/download/home/cm/a%20b%23c%3Fd.png`);
  });

  it("绝对 http(s) 地址透传，不拼 /download", async () => {
    const { mod } = await loadReady();
    const cdn = "https://cdn.example.com/img/a.png";
    expect(mod.downloadToUrl(cdn)).toBe(cdn);
  });

  it("web 态回落到 /file——该端点在 web 下不挂载", async () => {
    vi.stubEnv("VITE_API_ROOT", "");
    const { mod } = await loadModule({ isWeb: true });
    await mod.initHttpServerBaseUrl();

    const url = mod.downloadToUrl("/home/cm/a.png");
    expect(url).toBe("/file?path=%2Fhome%2Fcm%2Fa.png");
    expect(url).not.toContain("/download/");
  });

  it("空值与未初始化的 base 返回空串", async () => {
    const ready = await loadReady();
    expect(ready.mod.downloadToUrl("")).toBe("");
    expect(ready.mod.downloadToUrl("   ")).toBe("");

    const cold = await loadModule();
    expect(cold.mod.downloadToUrl("/a.png")).toBe("");
  });

  it("Windows 路径整条作为一段编码，反斜杠转成 %5C", async () => {
    const { mod } = await loadReady();
    const url = mod.downloadToUrl("C:\\Users\\cm\\Pictures\\a.png");

    expect(url).toBe(`${BASE}/download/C%3A%5CUsers%5Ccm%5CPictures%5Ca.png`);
    expect(url).not.toContain("\\");
  });
});

describe("downloadToUrl 与后端通配路由的往返契约", () => {
  const cases: { name: string; path: string }[] = [
    { name: "普通路径", path: "/home/cm/a.png" },
    { name: "中文与全角标点", path: CJK_PATH },
    { name: "空格", path: "/home/cm/with space/a b.png" },
    { name: "井号", path: "/home/cm/hash#tag.png" },
    { name: "问号", path: "/home/cm/query?x=1.png" },
    { name: "与号", path: "/home/cm/amp&and.png" },
    { name: "百分号字面量", path: "/home/cm/percent%20literal.png" },
    { name: "加号", path: "/home/cm/plus+one.png" },
    { name: "emoji", path: "/home/cm/emoji😀.png" },
    { name: "单引号", path: "/home/cm/quote'single.png" },
    { name: "逗号与括号", path: "/home/cm/comma,(1).png" },
    { name: "Windows 路径", path: "C:\\Users\\cm\\Pictures\\a.png" },
  ];

  it.each(cases)("$name 能原样还原", async ({ path }) => {
    const { mod } = await loadReady();
    expect(decodeLikeBackend(mod.downloadToUrl(path))).toBe(path);
  });
});

describe("thumbnailToUrl / compatibleToUrl", () => {
  it("各自走自己的端点并整条编码进 query", async () => {
    const { mod } = await loadReady();
    expect(mod.thumbnailToUrl(CJK_PATH)).toBe(
      `${BASE}/thumbnail?path=${encodeURIComponent(CJK_PATH)}`,
    );
    expect(mod.compatibleToUrl(CJK_PATH)).toBe(
      `${BASE}/compatible?path=${encodeURIComponent(CJK_PATH)}`,
    );
  });

  it("空值返回空串，绝对地址透传", async () => {
    const { mod } = await loadReady();
    const cdn = "https://cdn.example.com/t.png";
    expect(mod.thumbnailToUrl("")).toBe("");
    expect(mod.compatibleToUrl("")).toBe("");
    expect(mod.thumbnailToUrl(cdn)).toBe(cdn);
    expect(mod.compatibleToUrl(cdn)).toBe(cdn);
  });
});
