/**
 * CPU 侧的场景状态（P3a 点 2）：就地写落在它上面并标脏，`GpuScene.sync` 每帧把脏项刷进对应 draw 的 uniform 块、
 * 图层可见性或泛光链参数，一帧之内生效。
 *
 * 它**独立于 GPU**：只是数据加脏集合。draw 的 uniform 组装是纯函数（`render/uniforms.ts` 的 `drawUniformValues`），
 * 单测在 Node 里就能核对「就地改值后的 uniform 字节 = 用新值整场重编译得到的字节」，这是本阶段最主要的正确性判据。
 * 3b 的脚本写的也是这个状态（`write` 的目标形状复用绑定表，值按 3b 的返回值规则换算）。
 */
import { bindingValue, type SceneBinding, type TargetKey, type LayerField } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneScalar } from "../compile/model";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";

export interface LayerState {
  /** angles 为弧度（同 scene.json）。 */
  origin: number[];
  scale: number[];
  angles: number[];
  alpha: number;
  color: number[];
  brightness: number;
  visible: boolean;
}

export type WriteResult = "applied" | "recompile";

export interface DirtyState {
  layers: Set<number>;
  passes: Set<TargetKey>;
  bloom: boolean;
}

function layerStateOf(layer: SceneLayer): LayerState {
  return {
    origin: [...layer.origin],
    scale: [...layer.scale],
    angles: [...layer.angles],
    alpha: layer.alpha,
    color: [...layer.color],
    brightness: layer.brightness,
    visible: layer.visible,
  };
}

/** 就地写一条泛光绑定；值与编译期 `bloomParams` 同一规则（取不到合法数字时回默认值，级数截断小数）。 */
export function writeBloomParam(
  params: BloomParams,
  field: keyof BloomParams,
  raw: SceneScalar,
  condition: string | undefined,
): BloomParams {
  const value = bindingValue(raw, condition, field === "tint" ? "vec3" : "float");
  const values = Array.isArray(value) ? value : [value ? 1 : 0];
  const next: BloomParams = { ...params, tint: [params.tint[0], params.tint[1], params.tint[2]] };
  if (field === "tint") {
    next.tint =
      values.length >= 3 && values.slice(0, 3).every(Number.isFinite)
        ? [values[0], values[1], values[2]]
        : [BLOOM_DEFAULTS.tint[0], BLOOM_DEFAULTS.tint[1], BLOOM_DEFAULTS.tint[2]];
  } else if (field === "hdrIterations") {
    const value = values[0];
    next.hdrIterations = Number.isFinite(value) ? Math.trunc(value) : BLOOM_DEFAULTS.hdrIterations;
  } else {
    const value = values[0];
    next[field] = Number.isFinite(value) ? value : BLOOM_DEFAULTS[field];
  }
  return next;
}

/** 图层字段的缺省值（与编译期 `numbers(resolveValue(…), 缺省)` 同一套：解析不出分量时退回）。 */
const LAYER_DEFAULTS: Record<Exclude<LayerField, "visible">, number[]> = {
  origin: [0, 0, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0],
  alpha: [1],
  color: [1, 1, 1],
  brightness: [1],
};

function writeLayer(layer: LayerState, field: LayerField, value: number[] | boolean): void {
  if (field === "visible") {
    layer.visible = value !== false;
    return;
  }
  const values = Array.isArray(value) ? value : [value ? 1 : 0];
  if (field === "alpha" || field === "brightness") {
    const first = values[0];
    layer[field] = Number.isFinite(first) ? first : 1;
    return;
  }
  layer[field] = values.length ? [...values] : [...LAYER_DEFAULTS[field]];
}

export class SceneState {
  /** 按 `objects` 下标（稳定键）；只含进了 bundle 的图层。 */
  readonly layers = new Map<number, LayerState>();
  /** pass 稳定键 → 材质常量覆盖（uniform 名 → 分量）；起始值 = 编译期的 `pass.uniforms`。 */
  readonly constants = new Map<TargetKey, Record<string, number[]>>();
  bloom: BloomParams;
  private dirtyLayers = new Set<number>();
  private dirtyPasses = new Set<TargetKey>();
  private bloomDirty = false;

  private constructor(
    layers: Map<number, LayerState>,
    constants: Map<TargetKey, Record<string, number[]>>,
    bloom: BloomParams,
  ) {
    this.layers = layers;
    this.constants = constants;
    this.bloom = bloom;
  }

  static fromBundle(bundle: SceneBundle): SceneState {
    const layers = new Map<number, LayerState>();
    const constants = new Map<TargetKey, Record<string, number[]>>();
    for (const layer of bundle.layers) {
      layers.set(layer.object, layerStateOf(layer));
      for (const pass of layer.passes) constants.set(pass.key, { ...pass.uniforms });
      for (const effect of layer.effects)
        for (const step of effect.steps)
          if (step.kind === "draw") constants.set(step.pass.key, { ...step.pass.uniforms });
      if (layer.passthrough) constants.set(layer.passthrough.key, { ...layer.passthrough.uniforms });
    }
    const { bloom } = bundle.general;
    return new SceneState(layers, constants, { ...bloom, tint: [...bloom.tint] });
  }

  /**
   * 一条绑定的写入；目标不在当前 bundle 里（如被排除的 effect）返回 `"applied"` 且不做事，
   * 重编译类目标返回 `"recompile"`（调用方整场重编译）。
   */
  write(binding: SceneBinding, raw: SceneScalar): WriteResult {
    const { target } = binding;
    if (target.kind === "recompile") return "recompile";
    if (target.kind === "layer") {
      const layer = this.layers.get(target.object);
      if (layer) {
        writeLayer(layer, target.field, bindingValue(raw, binding.condition, target.field));
        this.dirtyLayers.add(target.object);
      }
      return "applied";
    }
    if (target.kind === "constant") {
      const constants = this.constants.get(target.pass);
      if (!constants) return "applied";
      const value = bindingValue(raw, binding.condition, target.type);
      const values = Array.isArray(value) ? value : [value ? 1 : 0];
      for (const name of target.uniforms) constants[name] = [...values];
      this.dirtyPasses.add(target.pass);
      return "applied";
    }
    this.bloom = writeBloomParam(this.bloom, target.field, raw, binding.condition);
    this.bloomDirty = true;
    return "applied";
  }

  /** 估算一批写入之后的泛光参数（不改状态）：渲染器据此先问 GPU 场景能不能就地改（级数会不会变）。 */
  previewBloom(writes: readonly { binding: SceneBinding; value: SceneScalar }[]): BloomParams {
    let bloom = this.bloom;
    for (const { binding, value } of writes)
      if (binding.target.kind === "bloom")
        bloom = writeBloomParam(bloom, binding.target.field, value, binding.condition);
    return bloom;
  }

  /** 渲染器每帧取走脏项（取走即清空）。 */
  takeDirty(): DirtyState {
    const dirty = { layers: this.dirtyLayers, passes: this.dirtyPasses, bloom: this.bloomDirty };
    this.dirtyLayers = new Set();
    this.dirtyPasses = new Set();
    this.bloomDirty = false;
    return dirty;
  }
}
