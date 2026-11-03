import { describe, expect, it, vi } from "vitest";
import type { SceneScripts } from "../compile/scripts";
import { SCRIPT_HIDDEN_GLOBALS } from "./environment";
import { buildScriptImportMap, JsModuleIndexImpl } from "./realm";

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

it("遮蔽表覆盖计划中的全局及实测可删除的 frame 引用", () => {
  expect(SCRIPT_HIDDEN_GLOBALS).toEqual(
    expect.arrayContaining([
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "Worker",
      "SharedWorker",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "caches",
      "Intl",
      "WebAssembly",
      "__TAURI_INTERNALS__",
      "window",
      "document",
      "top",
      "location",
      "parent",
      "self",
      "frames",
    ]),
  );
});
