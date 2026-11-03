import { invoke } from "@tauri-apps/api/core";
import { compileSceneInWorker } from "../compile/client";
import type { SceneBundle } from "../compile/bundle";
import { FetchSceneReader, SceneFs } from "../compile/fs";
import { SceneState } from "../render/state";
import type { SceneReporter } from "../report";
import { ScriptApi } from "../script/api";
import { createIframeRealm, getJsModuleIndex } from "../script/realm";
import { ScriptRuntime } from "../script/runtime";

interface Target {
  path: string;
  sceneAssets: string[];
}

/** 逐张场景在独立 realm 中运行有限的 120 帧；没有 GPU 或 rAF。 */
export async function scriptCorpus(imageIds: string[]): Promise<unknown> {
  const rows: unknown[] = [];
  const missingApis: Record<string, number> = {};
  let remainingTestFrames = 0;
  for (const imageId of imageIds) {
    let runtime: ScriptRuntime | null = null;
    let realm: Awaited<ReturnType<typeof createIframeRealm>> | null = null;
    let bundle: SceneBundle | null = null;
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
      const warnings: string[] = [];
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
      });
      let elapsed = 0;
      const api = new ScriptApi(realm, {
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
      });
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
        enterScript: (script) => api.enterScript(script),
        setProperties: (full) => api.setProperties(full),
        setModuleEvaluating: (value) => api.setModuleEvaluating(value),
      });
      api.attachRuntime(runtime);
      await runtime.load(bundle.scripts);
      runtime.applyUserProperties(Object.fromEntries(properties), properties, bundle.bindings);
      remainingTestFrames = 120;
      for (let frame = 0; frame < 120; frame++) {
        elapsed += 1 / 60;
        runtime.frame(1 / 60);
        remainingTestFrames--;
      }
      runtime.destroy();
      const diagnostics = runtime.diagnostics as { errors: string[] }[];
      runtime = null;
      realm = null;
      for (const item of diagnostics)
        for (const error of item.errors) {
          const key =
            /(?:engine|thisLayer|thisObject|thisScene|input)\.([A-Za-z_$][\w$]*)/.exec(error)?.[0] ??
            /([A-Za-z_$][\w$]*) is not defined/.exec(error)?.[1];
          if (key) missingApis[key] = (missingApis[key] ?? 0) + 1;
        }
      rows.push({ imageId, unsupported: bundle.unsupported, scripts: diagnostics, warnings });
    } catch (error) {
      rows.push({ imageId, error: String(error) });
    } finally {
      runtime?.destroy();
      if (!runtime) realm?.dispose();
      if (bundle) for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
      remainingTestFrames = 0;
    }
  }
  return { rows, missingApis, remainingTestFrames };
}
