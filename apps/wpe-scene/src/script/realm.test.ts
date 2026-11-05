import { describe, expect, it, vi } from "vitest";
import type { SceneScripts } from "../compile/scripts";
import { createWpeLocalStorage } from "./api";
import { alignScriptEnvironment } from "./environment";
import { buildScriptImportMap, JsModuleIndexImpl } from "./realm";
import { createMemoryStorage, SCENE_STORAGE_PREFIX } from "./storage";

function scripts(...imports: string[][]): SceneScripts {
  return { list: imports.map((names) => ({ imports: names })) } as SceneScripts;
}

describe("场景脚本 import map", () => {
  it("保留说明符写法、按小写文件查找并递归补齐依赖", async () => {
    const lookup = vi.fn(async (name: string) => {
      if (name === "wevector") return { url: "file:///wevector.js", imports: ["WEMath", "./relative.js"] };
      if (name === "wemath") return { url: "file:///wemath.js", imports: ["WEColor"] };
      if (name === "wecolor") return { url: "file:///wecolor.js", imports: [] };
      return null;
    });
    const map = await buildScriptImportMap(scripts(["WEVector", "wevector", "WEMath", "Missing", "./local.js"]), {
      lookup,
    });
    expect(map).toEqual({
      WEVector: "file:///wevector.js",
      WEMath: "file:///wemath.js",
      WEColor: "file:///wecolor.js",
      wevector: "file:///wevector.js",
    });
    expect(lookup).not.toHaveBeenCalledWith("./local.js");
    expect(lookup).not.toHaveBeenCalledWith("./relative.js");
  });
});

describe("JsModuleIndex", () => {
  it("按 assets 顺序读取首个存在的模块，成功与缺失均缓存", async () => {
    const fetchModule = vi.fn(async (url: string) => ({
      ok: url.includes("/second/") && url.endsWith("wemath.js"),
      text: async () => "import * as WEColor from 'WEColor'; export const x = 1;",
    }));
    const index = new JsModuleIndexImpl(["D:/first", "D:/second"], fetchModule);
    expect(await index.lookup("WEMath")).toEqual({
      url: "file:///D:/second/scripts/jsmodules/wemath.js",
      imports: ["WEColor"],
    });
    expect(await index.lookup("wemath")).toEqual(await index.lookup("WEMath"));
    expect(fetchModule).toHaveBeenCalledTimes(2);
    expect(await index.lookup("absent")).toBeNull();
    expect(await index.lookup("ABSENT")).toBeNull();
    expect(fetchModule).toHaveBeenCalledTimes(4);
    expect(index.cacheHits).toBe(3);
  });
});

describe("脚本环境改写（3c 点 0：不再遮蔽）", () => {
  function child(): Window {
    return {
      fetch: () => Promise.resolve(),
      document: {},
      setTimeout,
      localStorage: "native",
    } as unknown as Window;
  }

  it("console 只有 log / error，localStorage 换成 WPE 对象，其余浏览器全局保留", () => {
    const frame = child();
    const output = { log: vi.fn(), error: vi.fn() };
    const wpe = { get() {}, set() {}, delete() {}, clear() {} };
    alignScriptEnvironment(frame, output, wpe);
    const global = frame as unknown as Record<string, unknown>;
    expect(global.console).toEqual({ log: output.log, error: output.error });
    expect(Object.keys(global.console as object).sort()).toEqual(["error", "log"]);
    expect(global.localStorage).toBe(wpe);
    // 浏览器全局不再遮蔽
    expect(typeof global.fetch).toBe("function");
    expect(typeof global.setTimeout).toBe("function");
    expect(global.document).toEqual({});
  });

  it("WPE localStorage 的形状：四个方法与两个位置常量，没有 remove", () => {
    const backend = createMemoryStorage();
    const object = createWpeLocalStorage({
      global: { Object, JSON } as unknown as Record<string, unknown>,
      backend,
      sceneKey: "7",
      isEvaluating: () => false,
    }) as Record<string, unknown>;
    expect(Object.keys(object).sort()).toEqual(["LOCATION_GLOBAL", "LOCATION_SCREEN", "clear", "delete", "get", "set"]);
    expect("remove" in object).toBe(false);
    expect(object.LOCATION_GLOBAL).toBe(0);
    expect(object.LOCATION_SCREEN).toBe(1);
    (object.set as (key: string, value: unknown) => void)("k", [1, 2]);
    expect((object.get as (key: string) => unknown)("k")).toEqual([1, 2]);
  });

  it("脚本读不到宿主自己的 localStorage 键", () => {
    const backend = createMemoryStorage();
    backend.setItem("kabegame-dev-scene-force-render", "1");
    const object = createWpeLocalStorage({
      global: { Object, JSON } as unknown as Record<string, unknown>,
      backend,
      sceneKey: "7",
      isEvaluating: () => false,
    }) as Record<string, unknown>;
    expect((object.get as (key: string) => unknown)("kabegame-dev-scene-force-render")).toBeUndefined();
    (object.clear as () => void)();
    expect(backend.getItem("kabegame-dev-scene-force-render")).toBe("1");
    expect(backend.length).toBe(1);
    expect(backend.key(0)).toBe("kabegame-dev-scene-force-render");
    expect(SCENE_STORAGE_PREFIX).toBe("kabegame:wpe-scene:ls:");
  });
});
