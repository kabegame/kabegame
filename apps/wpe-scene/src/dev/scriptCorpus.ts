import { invoke } from "@tauri-apps/api/core";
import { compileSceneInWorker } from "../compile/client";
import type { SceneBundle } from "../compile/bundle";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import { FetchSceneReader, SceneFs } from "../compile/fs";
import { SceneState } from "../render/state";
import { createProbeScripts, probeScriptsOptionsOf, readProbeUserProperties, type ProbeScripts } from "./probeScripts";
import { classifyScriptError, type ScriptErrorKind } from "./scriptErrors";

interface Target {
  path: string;
  sceneAssets: string[];
}

/** 诊断里与语料统计相关的字段（`ProbeScriptsResult.diagnostics` 的子集）。 */
interface ScriptDiagnostic {
  id: string;
  errors: string[];
  targetKind: string;
  recompileWrites: number;
  calls?: Record<string, { count: number; maxMs?: number }>;
}

interface MissingApiGroup {
  kind: ScriptErrorKind;
  name: string;
  scenes: Set<string>;
  segments: Set<string>;
  errors: number;
}

export interface ScriptCorpusOptions {
  frames?: number;
  dt?: number;
  clock?: number;
  seed?: number;
  postprocess?: ScenePostprocessSetting;
}

/** 残留的测试 realm：数 DOM 里的 iframe，而不是数 120 帧循环的倒计数。 */
function realmFrameCount(): number {
  return document.querySelectorAll('iframe[data-kb-script-realm="1"]').length;
}

const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * 把任意值整理成键排序、可 JSON 化的普通数据：Map 转按键排序的 `[key, value]` 数组，Set 转排序数组，
 * 对象键排序，类型化数组转普通数组，非有限数转字符串（JSON 会把它们都写成 null），函数与 undefined 丢弃。
 */
function canonical(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, (item) => canonical(item));
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map)
    return [...value.entries()].map(([key, item]): [string, unknown] => [String(key), canonical(item)]).sort(byKey);
  if (value instanceof Set)
    return [...value]
      .map((item) => canonical(item))
      .sort((a, b) => {
        const x = JSON.stringify(a);
        const y = JSON.stringify(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = canonical((value as Record<string, unknown>)[key]);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

/**
 * `SceneState` 里脚本能写到的数据部分，整理成键排序、可 JSON 化的普通对象（`canonical`）。
 * 跳过：`texts`（排版结果含字形网格与图集，是 GPU 侧产物；脚本能写的排版字段在 `textFields`）、
 * 各 `dirty*` 脏集合、`transformWrites`、`shadowPasses`、`frozenLayers`、`alignmentSizes` 等派生 / 内部簿记、
 * `onUserTexture` 回调。
 */
export function stateSnapshot(state: SceneState): unknown {
  // `effects` 是私有成员：开关表只有这里要整表读，不为它改 state.ts
  const effects = (state as unknown as { effects: Map<string, unknown> }).effects;
  return canonical({
    layers: state.layers,
    constants: state.constants,
    effects,
    general: state.general,
    bloom: state.bloom,
    bloomEnabled: state.bloomEnabled,
    textFields: state.textFields,
    cameras: state.cameras,
    sounds: state.sounds,
    particleInstances: state.particleInstances,
    animationLayers: state.animationLayers,
    passStates: state.passStates,
    userTextures: state.userTextures,
    userWritten: state.userWritten,
  });
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 去掉每个回调的 `maxMs`（计时，不确定），只留 `count`。 */
function stripTiming(diagnostics: unknown[]): unknown[] {
  return diagnostics.map((item) => {
    const diagnostic = item as ScriptDiagnostic;
    if (!diagnostic.calls) return diagnostic;
    const calls: Record<string, { count: number }> = {};
    for (const [name, stats] of Object.entries(diagnostic.calls)) calls[name] = { count: stats.count };
    return { ...diagnostic, calls };
  });
}

/** 逐张场景在独立 realm 中确定地运行有限帧（缺省 120 帧）；没有 GPU 或 rAF。 */
export async function scriptCorpus(imageIds: string[], options: ScriptCorpusOptions = {}): Promise<unknown> {
  const { frames = 120, dt = 1 / 60, postprocess = "follow" } = options;
  const resolved = probeScriptsOptionsOf({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    consoleGrep: ".*",
  })!;
  const rows: unknown[] = [];
  const groups = new Map<string, MissingApiGroup>();
  const framesBefore = realmFrameCount();
  for (const imageId of imageIds) {
    let scripts: ProbeScripts | null = null;
    let bundle: SceneBundle | null = null;
    try {
      const target = await invoke<Target>("wpe_scene_target", { imageId });
      const reader = new FetchSceneReader();
      const fs = new SceneFs(target.path, target.sceneAssets, reader);
      const project = JSON.parse((await fs.text("project.json")) ?? "{}") as {
        general?: { properties?: Record<string, { type: string; value: unknown }> };
      };
      const defaults = Object.entries(project.general?.properties ?? {});
      bundle = await compileSceneInWorker({
        projectDir: target.path,
        sceneAssets: target.sceneAssets,
        postprocess,
        userProperties: Object.fromEntries(defaults.map(([key, value]) => [key, value.value])),
        force: true,
        exhaustive: true,
        reader,
      });
      const state = SceneState.fromBundle(bundle);
      // 同 `renderFrame`：全部用户属性（含 WPE 内置项）
      const properties = await readProbeUserProperties(reader, target.path, target.sceneAssets, undefined);
      // 透视场景没有场景尺寸，脚本的 screenResolution 取画布：语料扫描没有画布，按 1920×1080
      const screen: [number, number] = bundle.general.perspective
        ? [1920, 1080]
        : [bundle.general.width, bundle.general.height];
      scripts = createProbeScripts({
        bundle,
        state,
        sceneAssets: target.sceneAssets,
        properties,
        screen,
        options: resolved,
      });
      await scripts.load();
      for (let frame = 1; frame <= frames; frame++) {
        const time = frame * dt;
        scripts.enterFrame?.(dt, time);
        scripts.frame(dt, time);
      }
      const result = scripts.result();
      const diagnostics = stripTiming(result.diagnostics);
      for (const item of diagnostics as ScriptDiagnostic[]) {
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
      rows.push({
        imageId,
        unsupported: bundle.unsupported,
        scripts: diagnostics,
        stateDigest: await sha256Hex(JSON.stringify(stateSnapshot(state))),
        console: {
          count: result.console.count,
          digest: await sha256Hex((result.console.matched ?? []).join("\n")),
          tail: result.console.tail,
        },
        messages: result.messages,
        recompile: result.recompile,
        unconnected: result.unconnected,
        ...(result.console.matchedDropped ? { matchedDropped: result.console.matchedDropped } : {}),
      });
    } catch (error) {
      rows.push({ imageId, error: String(error) });
    } finally {
      scripts?.dispose();
      if (bundle) for (const texture of bundle.textures) for (const mip of texture.mips) mip.bitmap?.close();
    }
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
  return {
    rows,
    missingApis,
    remainingTestFrames: { before: framesBefore, after: realmFrameCount() },
    options: { frames, dt, clock: resolved.clock, seed: resolved.seed },
  };
}
