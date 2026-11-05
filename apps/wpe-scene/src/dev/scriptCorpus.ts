import { invoke } from "@tauri-apps/api/core";
import { compileSceneInWorker } from "../compile/client";
import type { SceneBundle } from "../compile/bundle";
import { FetchSceneReader, SceneFs } from "../compile/fs";
import { SceneState } from "../render/state";
import type { SceneReporter } from "../report";
import { createWpeLocalStorage, ScriptApi } from "../script/api";
import { createIframeRealm, getJsModuleIndex } from "../script/realm";
import { ScriptRuntime } from "../script/runtime";
import { browserStorage, clearStoragePrefix, SCENE_STORAGE_PREFIX } from "../script/storage";
import { classifyScriptError, type ScriptErrorKind } from "./scriptErrors";

interface Target {
  path: string;
  sceneAssets: string[];
}

/** 诊断里与语料统计相关的字段（`runtime.diagnostics` 的子集）。 */
interface ScriptDiagnostic {
  id: string;
  errors: string[];
  targetKind: string;
  recompileWrites: number;
}

interface MissingApiGroup {
  kind: ScriptErrorKind;
  name: string;
  scenes: Set<string>;
  segments: Set<string>;
  errors: number;
}

/** 残留的测试 realm：数 DOM 里的 iframe，而不是数 120 帧循环的倒计数。 */
function realmFrameCount(): number {
  return document.querySelectorAll('iframe[data-kb-script-realm="1"]').length;
}

/** 逐张场景在独立 realm 中运行有限的 120 帧；没有 GPU 或 rAF。 */
export async function scriptCorpus(imageIds: string[]): Promise<unknown> {
  const rows: unknown[] = [];
  const groups = new Map<string, MissingApiGroup>();
  const framesBefore = realmFrameCount();
  // 每次调用一个唯一的临时图片 id 前缀：脚本写 localStorage 只会落在这个前缀下，跑完清掉，不碰真实场景存的东西。
  const runId = `corpus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const backend = browserStorage();
  try {
    for (const imageId of imageIds) {
      let runtime: ScriptRuntime | null = null;
      let api: ScriptApi | null = null;
      let realm: Awaited<ReturnType<typeof createIframeRealm>> | null = null;
      let bundle: SceneBundle | null = null;
      const warnings: string[] = [];
      try {
        const target = await invoke<Target>("wpe_scene_target", { imageId });
        const reader = new FetchSceneReader();
        const fs = new SceneFs(target.path, target.sceneAssets, reader);
        const project = JSON.parse((await fs.text("project.json")) ?? "{}") as {
          general?: { properties?: Record<string, { type: string; value: unknown }> };
        };
        const properties = new Map(Object.entries(project.general?.properties ?? {}));
        bundle = await compileSceneInWorker({
          projectDir: target.path,
          sceneAssets: target.sceneAssets,
          postprocess: "follow",
          userProperties: Object.fromEntries([...properties].map(([key, value]) => [key, value.value])),
          force: true,
          exhaustive: true,
          reader,
        });
        const compiled = bundle;
        const state = SceneState.fromBundle(bundle);
        const report: SceneReporter = {
          ready() {},
          fallback() {},
          info() {},
          debug() {},
          warn(message) {
            warnings.push(message);
          },
          error(message) {
            warnings.push(message);
          },
        };
        realm = await createIframeRealm({
          document,
          scripts: bundle.scripts,
          sceneAssets: target.sceneAssets,
          modules: getJsModuleIndex(target.sceneAssets),
          console: { log() {}, error: (message) => warnings.push(message) },
          localStorage: (global) =>
            createWpeLocalStorage({
              global,
              backend,
              sceneKey: `${runId}/${imageId}`,
              isEvaluating: () => api?.moduleEvaluating ?? false,
              debug: (message) => warnings.push(message),
            }),
        });
        let elapsed = 0;
        const current = (api = new ScriptApi(realm, {
          bundle: () => compiled,
          state: () => state,
          screenResolution: () => [compiled.general.width, compiled.general.height],
          frametime: () => 1 / 60,
          runtime: () => elapsed,
          timeOfDay: () => 0.5,
          write(target, value) {
            if (target.kind === "unsupported" || target.kind === "script-property") return false;
            if (target.kind === "recompile") return true;
            state.write({ property: "corpus", target }, Array.isArray(value) ? value.join(" ") : value);
            return true;
          },
          read(target) {
            if (target.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
            if (target.kind === "layer") {
              const value = state.layers.get(target.object)?.[target.field];
              return value === undefined ? null : typeof value === "number" ? [value] : value;
            }
            if (target.kind === "bloom") {
              const value = state.bloom[target.field];
              return Array.isArray(value) ? value : [value];
            }
            return null;
          },
        }));
        runtime = new ScriptRuntime(realm, {
          report,
          write(target, value) {
            if (target.kind === "unsupported" || target.kind === "script-property") return false;
            if (target.kind === "recompile") return true;
            state.write({ property: "corpus", target }, Array.isArray(value) ? value.join(" ") : value);
            return true;
          },
          read(target) {
            if (target.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
            if (target.kind === "layer") {
              const value = state.layers.get(target.object)?.[target.field];
              return value === undefined ? null : typeof value === "number" ? [value] : value;
            }
            if (target.kind === "bloom") {
              const value = state.bloom[target.field];
              return Array.isArray(value) ? value : [value];
            }
            return null;
          },
          enterScript: (script) => current.enterScript(script),
          setProperties: (full) => current.setProperties(full),
          setModuleEvaluating: (value) => current.setModuleEvaluating(value),
        });
        current.attachRuntime(runtime);
        await runtime.load(bundle.scripts);
        runtime.applyUserProperties(Object.fromEntries(properties), properties, bundle.bindings);
        for (let frame = 0; frame < 120; frame++) {
          elapsed += 1 / 60;
          runtime.frame(1 / 60);
        }
        const diagnostics = (runtime.diagnostics as ScriptDiagnostic[]).map((item) => ({
          ...item,
          // 两路写重编译目标：回调返回值（runtime）与 API 直接赋值（ScriptApi）
          recompileWrites: item.recompileWrites + (current.recompileWrites.get(item.id) ?? 0),
        }));
        for (const item of diagnostics) {
          for (const error of item.errors) {
            const { kind, name } = classifyScriptError(error);
            const key = `${kind}:${name}`;
            const group = groups.get(key) ?? {
              kind,
              name,
              scenes: new Set<string>(),
              segments: new Set<string>(),
              errors: 0,
            };
            group.scenes.add(imageId);
            group.segments.add(`${imageId}|${item.id}`);
            group.errors++;
            groups.set(key, group);
          }
        }
        runtime.destroy();
        runtime = null;
        realm = null;
        api = null;
        rows.push({ imageId, unsupported: bundle.unsupported, scripts: diagnostics, warnings });
      } catch (error) {
        rows.push({ imageId, error: String(error) });
      } finally {
        runtime?.destroy();
        if (!runtime) realm?.dispose();
        if (bundle) for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
      }
    }
  } finally {
    if (backend) clearStoragePrefix(backend, `${SCENE_STORAGE_PREFIX}${runId}`);
  }
  const missingApis = [...groups.values()]
    .map((group) => ({
      kind: group.kind,
      name: group.name,
      scenes: group.scenes.size,
      segments: group.segments.size,
      errors: group.errors,
    }))
    .sort((a, b) => b.errors - a.errors || b.segments - a.segments || a.name.localeCompare(b.name));
  return { rows, missingApis, remainingTestFrames: { before: framesBefore, after: realmFrameCount() } };
}
