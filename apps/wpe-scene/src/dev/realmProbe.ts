import { invoke } from "@tauri-apps/api/core";
import type { SceneHost } from "../host";
import { SCRIPT_HIDDEN_GLOBALS } from "../script/environment";
import { buildScriptImportMap, createIframeRealm, getJsModuleIndex } from "../script/realm";
import { messageOf } from "../script/runtime";

/**
 * 只求值模块，不调用回调或接入渲染器。`extraSources`：额外求值的测试源码（如故意写错的语法），
 * 结果按 `extra/<序号>` 列在 `scripts` 里，用来核对语法错误的行列补拿。
 */
export async function realmCheck(host: SceneHost, extraSources: readonly string[] = []): Promise<unknown> {
  const scripts = host.devScene.bundle?.scripts;
  if (!scripts) throw new Error("当前宿主没有已编译场景");
  const imageId = new URLSearchParams(location.search).get("kbScene");
  if (!imageId) throw new Error("宿主缺少 kbScene");
  const target = await invoke<{ sceneAssets: string[] }>("wpe_scene_target", { imageId });
  const modules = getJsModuleIndex(target.sceneAssets);
  const start = performance.now();
  const fetchBefore = modules.fetchCount;
  const hitsBefore = modules.cacheHits;
  const realm = await createIframeRealm({
    document,
    scripts,
    sceneAssets: target.sceneAssets,
    modules,
    console: { log: (text) => console.log(text), error: (text) => console.error(text) },
    debug: (text) => console.debug(text),
  });
  let result: Record<string, unknown>;
  try {
    const results: { id: string; status: "成功" | "失败"; exports?: string[]; error?: string }[] = [];
    const sources = [
      ...scripts.list.map((script) => ({ id: script.id, source: script.source })),
      ...extraSources.map((source, index) => ({ id: `extra/${index}`, source })),
    ];
    for (const { id, source } of sources) {
      try {
        const exports = await realm.importModule(source, id);
        results.push({ id, status: "成功", exports: Object.keys(exports) });
      } catch (error) {
        results.push({ id, status: "失败", error: messageOf(error) });
      }
    }
    const environment = await realm.importModule(
      `export const types = Object.fromEntries(${JSON.stringify(SCRIPT_HIDDEN_GLOBALS)}.map(n => [n, typeof globalThis[n]]));
       export const warnThrowsTypeError = (() => { try { console.warn("probe"); return false; } catch (error) { return error instanceof TypeError; } })();
       export const vec3 = typeof Vec3; export const vec3OnGlobal = "Vec3" in globalThis;`,
      "realmCheck 环境",
    );
    const fetchAfterFirst = modules.fetchCount;
    const secondMap = await buildScriptImportMap(scripts, modules);
    result = {
      importMap: realm.importMap,
      scripts: results,
      environment: environment.types,
      consoleWarnThrowsTypeError: environment.warnThrowsTypeError,
      vec3: { moduleType: environment.vec3, onGlobal: environment.vec3OnGlobal },
      moduleCache: {
        fetchesFirst: fetchAfterFirst - fetchBefore,
        fetchesSecond: modules.fetchCount - fetchAfterFirst,
        hits: modules.cacheHits - hitsBefore,
        sameMap: JSON.stringify(secondMap) === JSON.stringify(realm.importMap),
      },
      elapsedMs: performance.now() - start,
    };
  } finally {
    realm.dispose();
  }
  return { ...result, remainingFrames: document.querySelectorAll('iframe[data-kb-script-realm="1"]').length };
}
