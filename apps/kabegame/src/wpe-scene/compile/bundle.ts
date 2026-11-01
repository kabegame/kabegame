import { SceneFs, type ResourceScope, type SceneReader } from "./fs";
import {
  checkEffectFeatures,
  checkModelFeatures,
  checkPassFeatures,
  checkProgramFeatures,
  checkSceneFeatures,
} from "./features";
import {
  currentProperties,
  numbers,
  parseEffect,
  parseMaterial,
  parseModel,
  parseProject,
  parseScene,
  resolveValue,
  textureName,
  type EffectFboJson,
  type MaterialPass,
  type SceneEffectInstance,
  type SceneScalar,
  type SceneValue,
} from "./model";
import {
  readWpePostprocessing,
  resolvePostprocessLevel,
  scenePostprocessState,
  type ScenePostprocessSetting,
  type ScenePostprocessState,
} from "./postprocess";
import { ShaderCompiler, type ShaderTextureSlot } from "./shader";
import { FBO_FORMATS, freeImageTextureSize, parseTex, TEX_FLAGS, type TexResult } from "./tex";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

export interface SceneGeneral {
  width: number;
  height: number;
  clearColor: number[];
  clearEnabled: boolean;
  camera: { eye: number[]; center: number[]; up: number[] };
  /** `g_LightAmbientColor` / `g_LightSkylightColor`。 */
  ambient: number[];
  skylight: number[];
  /** 本次编译解析出的后处理档位与场景实际的泛光 / HDR 状态（`postprocess.ts`）。 */
  postprocess: ScenePostprocessState;
}
export interface SceneMip {
  width: number;
  height: number;
  /** 原始像素或 BC 块（Worker 解出）。 */
  bytes?: Uint8Array;
  /** FreeImage 形态由主线程解码（`decode.ts`），跨重新编译缓存。 */
  bitmap?: ImageBitmap;
}
export interface SceneTexture {
  path: string;
  source: string;
  format: number;
  /** 图像尺寸（头里的 `width` / `height`）。 */
  width: number;
  height: number;
  /** 纹理尺寸：`g_Texture<n>Resolution.xy`、UV 上界的分母，渲染器按它建 GPU 纹理（FreeImage 见 `freeImageTextureSize`）。 */
  textureWidth: number;
  textureHeight: number;
  flags: number;
  clampUVs: boolean;
  noInterpolation: boolean;
  /** unsupported 非空时可能为空：编译器只读头部，不解码 mip；FreeImage 形态在主线程解码后才填。 */
  mips: SceneMip[];
  /** FreeImage 形态的 mip 位置（PNG / JPG 原文件），见 `TexResult.encoded`。 */
  encoded?: TexResult["encoded"];
  videoRange?: { start: number; end: number };
}
export interface ScenePass {
  program: number | null;
  blending: string;
  cullmode: string;
  depthtest: string;
  depthwrite: string;
  /** 槽位 → bundle 纹理。 */
  textures: Record<number, number>;
  /** 运行时提供的槽位：`_rt_FullFrameBuffer`（场景快照）或本 effect 的 fbo 名（材质 textures 或着色器注解默认值写的）。 */
  runtime: Record<number, string>;
  uniforms: Record<string, number[]>;
  /** 是否需要 `_rt_FullFrameBuffer` 快照（`needsFramebuffer`，决定快照时机）。 */
  framebuffer: boolean;
}
/** effect.json 的一张 fbo（B6）；尺寸由渲染图按图层合成 RT 算（`render/graph.ts` 的 `fboSize`）。 */
export interface SceneFbo {
  name: string;
  /** `FBO_FORMATS` 的键；`*_backbuffer` 已按 LDR / HDR 换算，不认识的按 `rgba8888`。 */
  format: string;
  scale: number;
  width?: number;
  height?: number;
  fit?: number;
  unique: boolean;
  /** 创建后清成该色（`"r g b [a]"`，缺 a 为 1）；缺省为全 0（WebGPU 纹理本来就是 0）。 */
  clear?: number[];
  repeat: boolean;
}
export type SceneEffectStep =
  | {
      kind: "draw";
      pass: ScenePass;
      /** 本 effect 的 fbo 名；null = 合成链。 */
      target: string | null;
      /** `compose: true`：写进合成 ping-pong（B6）。 */
      compose: boolean;
      /** `bind[]`；null 时槽 0 = 上一步输出。 */
      binds: { name: string; index: number }[] | null;
    }
  | { kind: "copy"; source: string; target: string }
  | { kind: "swap"; source: string; target: string };
/** 一个启用的 effect（未启用的不进 bundle，B11）。 */
export interface SceneEffect {
  id: number;
  name: string;
  file: string;
  fbos: SceneFbo[];
  steps: SceneEffectStep[];
}
export interface SceneLayer {
  id: number;
  name: string;
  origin: number[];
  scale: number[];
  angles: number[];
  size: number[];
  alpha: number;
  color: number[];
  visible: boolean;
  /** 基础材质的 pass。 */
  passes: ScenePass[];
  /** 0 普通；31 上屏改 additive；其它值走 passthrough（B7 / B8）。 */
  colorBlendMode: number;
  effects: SceneEffect[];
  /** colorBlendMode ∉ {0, 31} 时的上屏 pass（`PASSTHROUGH_MATERIAL`）。 */
  passthrough: ScenePass | null;
}
export interface SceneBundle {
  general: SceneGeneral;
  layers: SceneLayer[];
  programs: TranslateResult[];
  textures: SceneTexture[];
  /** 非空时渲染器必须回退预览图，不能用可能缺少 mip 的 textures 渲染。 */
  unsupported: string[];
}
export interface CompileSceneInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  reader: SceneReader;
  translator: Wpesl2wgsl | null;
  /** 设置「场景后处理」；缺省跟随 WPE。 */
  postprocess?: ScenePostprocessSetting;
  /** dev 强制渲染：有不支持项也照常解码 mip，好让渲染器画出半成品（D4）。 */
  force?: boolean;
  /**
   * 列全所有不支持项（语料统计、诊断用）。缺省时一旦确定要退回预览图就不再编译后面的图层：退回的场景越早出结果，
   * 预览图越早显示（翻译工坊场景的几十个 effect 着色器要上百次读取和不少 wasm 时间），这时 `unsupported` 只是部分清单。
   */
  exhaustive?: boolean;
}

/** 场景目标的整帧快照（B8）。 */
export const FRAMEBUFFER_RT = "_rt_FullFrameBuffer";

/**
 * colorBlendMode ∉ {0, 31} 时的 passthrough 上屏材质（B8，`FUN_1401ecae0` → 0x1401853b0）：看场景 `scene.json` 顶层的
 * `version`（缺键按 0），与显卡、画质设置无关。`version > 2` 用 `effectpassthrough_4.json`（`genericimage4`），否则用
 * `effectpassthrough.json`（`genericimage3`）。本机默认样本都 ≤ 1；工坊样本多数 ≥ 3，而 `genericimage4.frag` 顶层无条件
 * `#require LightingV1`，翻译失败照常记 `shader:genericimage4:require:LightingV1`，等 W1 给光照库打桩。
 */
export function passthroughMaterial(sceneVersion: unknown): string {
  const version = typeof sceneVersion === "number" && Number.isFinite(sceneVersion) ? sceneVersion : 0;
  return version > 2 ? "materials/util/effectpassthrough_4.json" : "materials/util/effectpassthrough.json";
}
/** passthrough 的 COMBO（B8）：`BLENDMODE = colorBlendMode`、`FOG_COMPUTED = 1`。 */
export function passthroughCombos(colorBlendMode: number): Record<string, number> {
  return { BLENDMODE: colorBlendMode, FOG_COMPUTED: 1 };
}

/**
 * 材质是否「需要帧缓冲」（WPE 材质 +0x1fc bit1，材质创建时由 `FUN_1401515b0` 算出，决定 `_rt_FullFrameBuffer` 的拷贝时机，B8）：
 * 某个纹理槽最终解析到的名字是 `_rt_FullFrameBuffer`。每个槽的解析顺序是材质 `textures` 里给的名字，没给取着色器注解的
 * `default`，都没有为 `error`。effect 里任一 pass 的材质需要，该 effect 就需要（`FUN_1401e7170`，见 `render/graph.ts`）。
 */
export function needsFramebuffer(slots: readonly (string | null)[], result: TranslateResult | null): boolean {
  const resolved = new Map<number, string>();
  for (const texture of result?.textures ?? [])
    if (typeof texture.meta?.default === "string") resolved.set(texture.slot, texture.meta.default);
  slots.forEach((name, slot) => {
    if (name) resolved.set(slot, name);
  });
  return [...resolved.values()].includes(FRAMEBUFFER_RT);
}

/** fbo 的 `format` → `FBO_FORMATS` 的键（B6）：`rgba_backbuffer` / `rgb_backbuffer` 随 HDR 变化，不认识的按 rgba8888。 */
export function fboFormat(format: string | undefined, hdr: boolean): string {
  if (format === "rgba_backbuffer") return hdr ? "rgba16161616f" : "rgba8888";
  if (format === "rgb_backbuffer") return hdr ? "rgb161616f" : "rgb888";
  return format && FBO_FORMATS[format] ? format : "rgba8888";
}

function parseFbo(raw: EffectFboJson, hdr: boolean): SceneFbo {
  const limit = (value: unknown) =>
    typeof value === "number" && value > 0 && value <= 4096 ? Math.round(value) : undefined;
  const clear = typeof raw.clear === "string" ? numbers(raw.clear) : [];
  return {
    name: String(raw.name ?? ""),
    format: fboFormat(raw.format, hdr),
    scale: typeof raw.scale === "number" && raw.scale >= 1 ? Math.floor(raw.scale) : 1,
    width: limit(raw.width),
    height: limit(raw.height),
    fit: limit(raw.fit),
    unique: raw.unique === true,
    clear: clear.length >= 3 ? [clear[0], clear[1], clear[2], clear[3] ?? 1] : undefined,
    repeat: raw.uvs === "repeat",
  };
}

const asNumber = (value: SceneScalar | undefined, fallback: number): number => {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
function texturePath(name: string): string {
  if (name.startsWith("_rt_")) return name;
  const path = name.endsWith(".tex") ? name : `${name}.tex`;
  return path.startsWith("materials/") ? path : `materials/${path}`;
}
/** effect 实例的 `textures` 只覆盖写了名字的槽位，null 保留材质自己的值。 */
function mergeTextures(base: unknown[] | undefined, override: unknown[] | undefined): (string | null)[] {
  const slots = (base ?? []).map(textureName);
  for (const [slot, raw] of (override ?? []).entries()) {
    const name = textureName(raw);
    if (name) slots[slot] = name;
  }
  return slots;
}
export function shaderUniforms(
  result: TranslateResult | null,
  pass: MaterialPass,
  properties: Record<string, SceneScalar>,
): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  if (!result?.ok) return values;
  for (const uniform of result.uniforms ?? []) {
    const material = uniform.meta?.material;
    if (typeof material !== "string") continue;
    const property = Object.entries(pass.usershadervalues ?? {}).find(([, target]) => target === material)?.[0];
    const raw =
      (property ? properties[property] : undefined) ??
      resolveValue(pass.constantshadervalues?.[material], properties) ??
      (uniform.meta?.default as SceneScalar | undefined);
    if (raw !== undefined) values[uniform.name] = numbers(raw);
  }
  return values;
}

/** 编译一个材质 pass 的上下文：effect 目录（资源查找）、本 effect 的 fbo，以及由渲染图填的槽位及其格式。 */
interface PassContext {
  scope?: ResourceScope | null;
  fbos?: ReadonlyMap<string, SceneFbo>;
  /** 渲染图运行时填的槽位（effect 无 bind 时的槽 0、bind 的各槽、passthrough 的槽 0）与其 `.tex` 格式枚举。 */
  planned?: ShaderTextureSlot[];
}

export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const fs = new SceneFs(input.projectDir, input.sceneAssets, input.reader);
  const unsupported = new Set<string>();
  const projectText = await fs.text("project.json");
  if (!projectText) throw new Error("缺少 project.json");
  const project = parseProject(projectText);
  const sceneText = await fs.text(project.file);
  if (!sceneText) throw new Error(`缺少场景入口：${project.file}`);
  const scene = parseScene(sceneText);
  const properties = currentProperties(project, input.userProperties ?? {});
  checkSceneFeatures(scene, unsupported);
  const general = scene.general ?? {},
    camera = scene.camera ?? {};
  // 后处理档位：每次加载都解析（设置变了由调用方重新编译）
  const setting = input.postprocess ?? "follow";
  const wpeSetting = setting === "follow" ? await readWpePostprocessing(input.reader, input.sceneAssets) : null;
  const postprocess = scenePostprocessState(resolvePostprocessLevel(setting, wpeSetting), general, properties);
  if (postprocess.bloom) unsupported.add("postprocess:bloom");
  if (postprocess.hdr) unsupported.add("postprocess:hdr");
  const projection =
    general.orthogonalprojection && typeof general.orthogonalprojection === "object"
      ? (general.orthogonalprojection as { width?: number; height?: number })
      : {};
  const bundle: SceneBundle = {
    general: {
      width: projection.width ?? 1920,
      height: projection.height ?? 1080,
      clearColor: numbers(resolveValue(general.clearcolor as SceneValue, properties), [0, 0, 0]),
      clearEnabled: general.clearenabled !== false,
      camera: {
        eye: numbers(resolveValue(camera.eye as SceneValue, properties), [0, 0, 1]),
        center: numbers(resolveValue(camera.center as SceneValue, properties), [0, 0, 0]),
        up: numbers(resolveValue(camera.up as SceneValue, properties), [0, 1, 0]),
      },
      ambient: numbers(resolveValue(general.ambientcolor as SceneValue, properties), [0, 0, 0]),
      skylight: numbers(resolveValue(general.skylightcolor as SceneValue, properties), [0, 0, 0]),
      postprocess,
    },
    layers: [],
    programs: [],
    textures: [],
    unsupported: [],
  };
  const shader = new ShaderCompiler(fs, input.translator, unsupported);
  const textureIndex = new Map<string, number>();
  const programIndex = new Map<TranslateResult, number>();
  const shouldDecode = () => input.force === true || unsupported.size === 0;
  /** 已确定退回且不需要列全时，停止编译后面的图层 / effect。 */
  const settled = () => unsupported.size > 0 && !input.force && !input.exhaustive;

  async function getTexture(
    name: string,
    scope: ResourceScope | null,
  ): Promise<{ index: number; format: number } | null> {
    const path = texturePath(name);
    const file = await fs.resolveScoped(path, scope);
    if (!file) {
      unsupported.add(`texture:missing:${path}`);
      return null;
    }
    const existing = textureIndex.get(file.path);
    if (existing !== undefined) return { index: existing, format: bundle.textures[existing].format };
    let tex: TexResult;
    try {
      tex = await parseTex(file, shouldDecode());
    } catch (error) {
      unsupported.add(`tex:parse:${path}:${String(error)}`);
      return null;
    }
    for (const key of tex.unsupported) unsupported.add(key);
    const [textureWidth, textureHeight] = tex.encoded
      ? freeImageTextureSize(tex)
      : [tex.textureWidth, tex.textureHeight];
    const index = bundle.textures.length;
    textureIndex.set(file.path, index);
    bundle.textures.push({
      path,
      source: file.source,
      format: tex.format,
      width: tex.width,
      height: tex.height,
      textureWidth,
      textureHeight,
      flags: tex.flags,
      clampUVs: !!(tex.flags & TEX_FLAGS.clampUVs),
      noInterpolation: !!(tex.flags & TEX_FLAGS.noInterpolation),
      mips:
        tex.images[0]?.mips.flatMap((mip) =>
          mip.bytes ? [{ width: mip.width, height: mip.height, bytes: mip.bytes }] : [],
        ) ?? [],
      encoded: tex.encoded,
      videoRange: tex.videoRange,
    });
    return { index, format: tex.format };
  }

  /** 编译一个材质 pass：纹理（含 `_rt_*` 与着色器注解默认值）、着色器、uniform、能力检查。 */
  async function compilePass(pass: MaterialPass, context: PassContext = {}): Promise<ScenePass> {
    checkPassFeatures(pass, unsupported);
    const scope = context.scope ?? null;
    const names = (pass.textures ?? []).map(textureName);
    const slots: Record<number, number> = {};
    const runtime: Record<number, string> = {};
    const formats: ShaderTextureSlot[] = [...(context.planned ?? [])];
    const planned = new Set(formats.map((item) => item.slot));
    const bindRuntime = (slot: number, name: string): boolean => {
      if (name === FRAMEBUFFER_RT) runtime[slot] = name;
      else if (context.fbos?.has(name)) runtime[slot] = name;
      else return false;
      return true;
    };
    for (const [slot, name] of names.entries()) {
      if (!name || planned.has(slot)) continue;
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name))
          formats.push({ slot, format: FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex });
        else unsupported.add(`texture:rendertarget:${name}`);
        continue;
      }
      const texture = await getTexture(name, scope);
      if (texture) {
        slots[slot] = texture.index;
        formats.push({ slot, format: texture.format });
      }
    }
    const result = pass.shader ? await shader.compile(pass.shader, pass.combos ?? {}, formats, scope) : null;
    if (!pass.shader) unsupported.add("shader:missing");
    let program: number | null = null;
    if (result?.ok) {
      checkProgramFeatures(result, unsupported);
      // 着色器声明了、材质没给的槽位按注解 `default` 绑定（同 LWE `setupTextureUniforms` 先取着色器默认值）
      for (const binding of result.textures ?? []) {
        const fallback = binding.meta?.default;
        if (typeof fallback !== "string" || !fallback) continue;
        if (planned.has(binding.slot) || binding.slot in slots || binding.slot in runtime) continue;
        if (fallback.startsWith("_rt_")) {
          if (!bindRuntime(binding.slot, fallback)) unsupported.add(`texture:rendertarget:${fallback}`);
          continue;
        }
        const texture = await getTexture(fallback, scope);
        if (texture) slots[binding.slot] = texture.index;
      }
      const old = programIndex.get(result);
      program = old ?? bundle.programs.length;
      if (old === undefined) {
        programIndex.set(result, program);
        bundle.programs.push(result);
      }
    }
    return {
      program,
      blending: pass.blending ?? "normal",
      cullmode: pass.cullmode ?? "nocull",
      depthtest: pass.depthtest ?? "disabled",
      depthwrite: pass.depthwrite ?? "disabled",
      textures: slots,
      runtime,
      uniforms: shaderUniforms(result, pass, properties),
      framebuffer: needsFramebuffer(names, result?.ok ? result : null),
    };
  }

  for (const object of scene.objects) {
    if (settled()) break;
    const layer: SceneLayer = {
      id: object.id ?? bundle.layers.length,
      name: object.name ?? "",
      origin: numbers(resolveValue(object.origin, properties), [0, 0, 0]),
      scale: numbers(resolveValue(object.scale, properties), [1, 1, 1]),
      angles: numbers(resolveValue(object.angles, properties), [0, 0, 0]),
      size: numbers(resolveValue(object.size, properties)),
      alpha: asNumber(resolveValue(object.alpha, properties), 1),
      color: numbers(resolveValue(object.color, properties), [1, 1, 1]),
      visible: resolveValue(object.visible, properties) !== false,
      passes: [],
      colorBlendMode: Math.trunc(asNumber(resolveValue(object.colorBlendMode as SceneValue, properties), 0)),
      effects: [],
      passthrough: null,
    };
    bundle.layers.push(layer);
    if (!object.image) continue;
    const modelText = await fs.text(object.image);
    if (!modelText) {
      unsupported.add(`model:missing:${object.image}`);
      continue;
    }
    const model = parseModel(modelText);
    checkModelFeatures(model, unsupported);
    if (!model.material) {
      unsupported.add("material:missing");
      continue;
    }
    const materialText = await fs.text(model.material);
    if (!materialText) {
      unsupported.add(`material:missing:${model.material}`);
      continue;
    }
    const material = parseMaterial(materialText);
    for (const pass of material.passes) layer.passes.push(await compilePass(pass));
    // 没写 size：先取模型的 width / height，没有再取基础纹理的图像尺寸（`autosize`）。不能反过来：deep_space 的
    // Background 模型写 1920×1080，槽 0 却是 480×270 的流向遮罩，按纹理取会缩成中间一小块（P1 一直按模型取）
    if (!layer.size.length) {
      const base = layer.passes[0]?.textures[0];
      const texture = base === undefined ? undefined : bundle.textures[base];
      layer.size =
        model.width && model.height
          ? [model.width, model.height]
          : texture
            ? [texture.width, texture.height]
            : [model.width ?? 0, model.height ?? 0];
    }

    for (const raw of Array.isArray(object.effects) ? object.effects : []) {
      if (settled()) break;
      const instance = (raw ?? {}) as SceneEffectInstance;
      // 未启用的 effect 整步跳过（B11），也不检查它的能力
      if (resolveValue(instance.visible, properties) === false) continue;
      const file = typeof instance.file === "string" ? instance.file : "";
      const label = file.split("/").at(-2) ?? "unknown";
      const effectFile = file ? await fs.read(file) : null;
      const effectText = effectFile ? new TextDecoder().decode(effectFile.bytes).replace(/^﻿/, "") : null;
      if (!effectFile || !effectText) {
        unsupported.add(`effect:missing:${file}`);
        continue;
      }
      const effect = parseEffect(effectText);
      checkEffectFeatures(instance, effect, label, unsupported);
      // effect 资源的查找范围：effect.json 所在目录；它来自 assets 时内置资源也在那里，先查它
      const scope: ResourceScope | null = file.includes("/")
        ? { dir: file.slice(0, file.lastIndexOf("/")), first: effectFile.source === "assets" }
        : null;
      const fbos = new Map(
        (effect.fbos ?? [])
          .map((item) => parseFbo(item, postprocess.hdr))
          .filter((item) => item.name)
          .map((item) => [item.name, item]),
      );
      const steps: SceneEffectStep[] = [];
      let overrideIndex = 0;
      for (const pass of effect.passes ?? []) {
        if (pass.command === "copy" || pass.command === "swap") {
          if (typeof pass.source === "string" && typeof pass.target === "string")
            steps.push({ kind: pass.command, source: pass.source, target: pass.target });
          continue;
        }
        if (typeof pass.material !== "string") continue;
        // 实例的 passes 按顺序对应 effect.json 里的绘制 pass（命令 pass 不占位，同 LWE `CImage::setup`）
        const override = instance.passes?.[overrideIndex++];
        const passMaterialText = await fs.text(pass.material, scope);
        if (!passMaterialText) {
          unsupported.add(`material:missing:${pass.material}`);
          continue;
        }
        const binds = Array.isArray(pass.bind)
          ? pass.bind
              .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))
              .map((bind) => ({ name: String(bind.name), index: Number(bind.index) }))
          : null;
        // 渲染图填的槽位：有 bind 时只按 bind；没有 bind 时槽 0 = 上一步输出（合成 RT）
        const planned: ShaderTextureSlot[] = binds
          ? binds.map((bind) => ({
              slot: bind.index,
              format: FBO_FORMATS[fbos.get(bind.name)?.format ?? "rgba8888"].tex,
            }))
          : [{ slot: 0, format: FBO_FORMATS.rgba8888.tex }];
        for (const materialPass of parseMaterial(passMaterialText).passes) {
          const merged: MaterialPass = {
            ...materialPass,
            combos: { ...materialPass.combos, ...override?.combos },
            constantshadervalues: { ...materialPass.constantshadervalues, ...override?.constantshadervalues },
            textures: mergeTextures(materialPass.textures, override?.textures),
          };
          // 有 bind 时材质槽 0 的 null 不再自动填（B6）：不在 planned 里的 null 槽位就保持空
          const compiled = await compilePass(merged, { scope, fbos, planned });
          steps.push({
            kind: "draw",
            pass: compiled,
            target: typeof pass.target === "string" ? pass.target : null,
            compose: pass.compose === true,
            binds,
          });
        }
      }
      layer.effects.push({
        id: instance.id ?? layer.effects.length,
        name: instance.name ?? "",
        file,
        fbos: [...fbos.values()],
        steps,
      });
    }

    const cbm = layer.colorBlendMode;
    if (cbm !== 0 && cbm !== 31) {
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) unsupported.add(`material:missing:${path}`);
      else {
        layer.passthrough = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(cbm) } },
          { planned: [{ slot: 0, format: FBO_FORMATS.rgba8888.tex }] },
        );
        // passthrough 上屏颜色置 (1, 1, 1, 1)（B8 / B10）
        layer.passthrough.uniforms.g_Color4 = [1, 1, 1, 1];
      }
    }
  }
  if (!input.sceneAssets.length) unsupported.add("assets:missing");
  bundle.unsupported = [...unsupported].sort();
  return bundle;
}

export function transferableBuffers(bundle: SceneBundle): ArrayBuffer[] {
  return [
    ...new Set(
      bundle.textures.flatMap((texture) =>
        texture.mips
          .map((mip) => mip.bytes?.buffer)
          .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
      ),
    ),
  ];
}
