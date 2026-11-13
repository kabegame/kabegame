import { invoke } from "@tauri-apps/api/core";
import type { SceneHost } from "../host";
import { createWpeLocalStorage, ScriptApi } from "../script/api";
import { buildScriptImportMap, createIframeRealm, getJsModuleIndex } from "../script/realm";
import { messageOf } from "../script/runtime";
import { browserStorage, clearStoragePrefix, SCENE_STORAGE_PREFIX } from "../script/storage";
import { SceneState } from "../render/state";

/** 探针写进宿主 `localStorage` 的键：用来核对脚本的 WPE `localStorage` 读不到宿主自己的键。 */
const HOST_KEY = "kabegame-scene-realm-check";

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
  const backend = browserStorage();
  const sceneKey = `realm-check-${Date.now().toString(36)}`;
  try {
    backend?.setItem(HOST_KEY, "host");
  } catch {
    // 宿主存储不可写时跳过这一项检查（脚本仍读不到，只是没有反证）。
  }
  const start = performance.now();
  const fetchBefore = modules.fetchCount;
  const hitsBefore = modules.cacheHits;
  let api: ScriptApi | null = null;
  let realm: Awaited<ReturnType<typeof createIframeRealm>> | null = null;
  let result: Record<string, unknown>;
  try {
    realm = await createIframeRealm({
      document,
      scripts,
      sceneAssets: target.sceneAssets,
      modules,
      console: { log: (text) => console.log(text), error: (text) => console.error(text) },
      localStorage: (global) =>
        createWpeLocalStorage({
          global,
          backend,
          sceneKey,
          isEvaluating: () => api?.moduleEvaluating ?? false,
          debug: (text) => console.debug(text),
        }),
    });
    const bundle = host.devScene.bundle!;
    const state = SceneState.fromBundle(bundle);
    const current = (api = new ScriptApi(realm, {
      bundle: () => bundle,
      state: () => state,
      // 透视场景（P5d 步骤 2）的场景尺寸是 0，脚本的 screenResolution 取画布：探针没有画布，按 1920×1080
      screenResolution: () =>
        bundle.general.perspective ? [1920, 1080] : [bundle.general.width, bundle.general.height],
      frametime: () => 0.016,
      runtime: () => 1,
      timeOfDay: () => 0.5,
      write(target, value) {
        if (target.kind === "unsupported" || target.kind === "recompile" || target.kind === "script-property")
          return false;
        state.write({ property: "probe", target }, Array.isArray(value) ? value.join(" ") : value);
        return true;
      },
    }));
    const results: { id: string; status: "成功" | "失败"; exports?: string[]; error?: string }[] = [];
    const sources = [
      ...scripts.list.map((script) => ({ id: script.id, source: script.source })),
      ...extraSources.map((source, index) => ({ id: `extra/${index}`, source })),
    ];
    for (const { id, source } of sources) {
      try {
        current.setModuleEvaluating(true);
        const exports = await realm.importModule(source, id);
        results.push({ id, status: "成功", exports: Object.keys(exports) });
      } catch (error) {
        results.push({ id, status: "失败", error: messageOf(error) });
      } finally {
        current.setModuleEvaluating(false);
      }
    }
    const environment = await realm.importModule(
      `export const consoleMembers = Object.keys(console).sort();
       export const localStorageMembers = Object.keys(localStorage).sort();
       export const localStorageHasRemove = "remove" in localStorage;
       export const locations = { global: localStorage.LOCATION_GLOBAL, screen: localStorage.LOCATION_SCREEN };
       export const fetchType = typeof fetch;
       export const hostKeyVisible = localStorage.get(${JSON.stringify(HOST_KEY)}) !== undefined;
       export const warnThrowsTypeError = (() => { try { console.warn("probe"); return false; } catch (error) { return error instanceof TypeError; } })();
       export const vec3 = typeof Vec3; export const vec3OnGlobal = "Vec3" in globalThis;`,
      "realmCheck 环境",
    );
    current.setModuleEvaluating(true);
    const apiModule = await realm.importModule(
      `export const topLevelFrametimeThrows = (() => { try { void engine.frametime; return false; } catch { return true; } })();
       export const topLevelLocalStorageThrows = (() => { try { localStorage.get("probe"); return false; } catch { return true; } })();
       export function check() {
         const layers = thisScene.enumerateLayers();
         const layer = thisScene.getLayer(0);
         const before = layer?.alpha ?? null;
         if (layer) layer.alpha = 0.25;
         return { frametime: engine.frametime, count: thisScene.getLayerCount(), enumerated: layers.length,
           firstName: layer?.name ?? null, vec3Instance: layer ? layer.origin instanceof Vec3 : null,
           alphaBefore: before, alphaAfter: layer?.alpha ?? null };
       }`,
      "realmCheck API",
    );
    current.setModuleEvaluating(false);
    const apiResult = (apiModule.check as () => Record<string, unknown>)();
    const fetchAfterFirst = modules.fetchCount;
    const secondMap = await buildScriptImportMap(scripts, modules);
    result = {
      importMap: realm.importMap,
      scripts: results,
      environment: {
        consoleMembers: environment.consoleMembers,
        localStorageMembers: environment.localStorageMembers,
        localStorageHasRemove: environment.localStorageHasRemove,
        locations: environment.locations,
        fetchType: environment.fetchType,
        hostKeyVisible: environment.hostKeyVisible,
      },
      consoleWarnThrowsTypeError: environment.warnThrowsTypeError,
      vec3: { moduleType: environment.vec3, onGlobal: environment.vec3OnGlobal },
      api: {
        topLevelFrametimeThrows: apiModule.topLevelFrametimeThrows,
        topLevelLocalStorageThrows: apiModule.topLevelLocalStorageThrows,
        ...apiResult,
      },
      moduleCache: {
        fetchesFirst: fetchAfterFirst - fetchBefore,
        fetchesSecond: modules.fetchCount - fetchAfterFirst,
        hits: modules.cacheHits - hitsBefore,
        sameMap: JSON.stringify(secondMap) === JSON.stringify(realm.importMap),
      },
      elapsedMs: performance.now() - start,
    };
  } finally {
    realm?.dispose();
    try {
      backend?.removeItem(HOST_KEY);
    } catch {
      // 清理失败不影响结果。
    }
    if (backend) clearStoragePrefix(backend, `${SCENE_STORAGE_PREFIX}${sceneKey}`);
  }
  return { ...result, remainingFrames: document.querySelectorAll('iframe[data-kb-script-realm="1"]').length };
}
