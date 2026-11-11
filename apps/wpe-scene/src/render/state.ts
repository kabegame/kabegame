/**
 * CPU 侧的场景状态（P3a 点 2）：就地写落在它上面并标脏，`GpuScene.sync` 每帧把脏项刷进对应 draw 的 uniform 块、
 * 图层可见性或泛光链参数，一帧之内生效。`bloomEnabled` 与清屏两项不标脏，`GpuScene.encode` 每帧直接读（A1、L4）。
 *
 * 它**独立于 GPU**：只是数据加脏集合。draw 的 uniform 组装是纯函数（`render/uniforms.ts` 的 `drawUniformValues`），
 * 单测在 Node 里就能核对「就地改值后的 uniform 字节 = 用新值整场重编译得到的字节」，这是本阶段最主要的正确性判据。
 * 3b 的脚本写的也是这个状态（`write` 的目标形状复用绑定表，值按 3b 的返回值规则换算）。
 *
 * 层级（P4a 步骤 1）：图层存的都是本地值，世界矩阵与继承后的可见性由渲染器按父链现算。所以写一个图层的
 * `origin`、`angles`、`scale`、`visible` 时，它和全部子孙一起标脏；`alpha`、`color`、`brightness` 不继承，只标自己。
 * 视差（P5a 步骤 2）的平移看根对象的 `origin` 与 `parallaxDepth`，所以 `parallaxDepth` 同样整棵子树标脏。
 *
 * 粒子（P4a 步骤 5）：`instanceoverride` 的标量与 `colorn`（P4b 步骤 6）存在 `particleInstances`，写入用编译期同一条取值规则
 * （`instanceScalar` / `instanceColorn`）、标脏后由 `GpuScene.sync` 交给模拟器从基值重新乘、重算颜色平移。
 *
 * 声音（P6a 步骤 1）：`volume` 存在 `sounds`，写入用编译期同一条取值规则（`soundVolume`），不标脏，宿主的排期器每帧读。
 */
import {
  bindingValue,
  generalValue,
  type BindingTarget,
  type GeneralValues,
  type LayerField,
  type SceneBinding,
  type TargetKey,
} from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { materialSetter, memberValue, type MaterialMember } from "../compile/materialValues";
import type { SceneScalar } from "../compile/model";
import {
  instanceColorn,
  instanceScalar,
  instanceValues,
  type ParticleInstanceValues,
  type SceneParticle,
} from "../compile/particles";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import { soundVolume } from "../compile/sounds";

export interface LayerState {
  /** angles 为弧度（同 scene.json）。都是本地值：世界矩阵与继承后的可见性按父链现算（`render/layout.ts`）。 */
  origin: number[];
  scale: number[];
  angles: number[];
  alpha: number;
  color: number[];
  brightness: number;
  /** 自身的值；画不画还要看祖先（`effectiveVisible`）。 */
  visible: boolean;
  /**
   * 视差深度（P5a 步骤 2，`SceneLayer.parallaxDepth`）：只有根对象的值起作用（WPE 绘制时沿父链取根，rea-p5-camera.md 6.3），
   * 子孙的平移跟着根变。
   */
  parallaxDepth: number[];
  /** 父对象的 `objects` 下标（`SceneLayer.parent`），根节点为 null。运行中不变。 */
  readonly parent: number | null;
}

/**
 * 会传给子孙的字段：世界矩阵用到的三项，加沿父链继承的 `visible`，以及子孙按根对象取的 `parallaxDepth`（P5a 步骤 2，根的 `origin`
 * 已在前三项里）。`alpha`、`color`、`brightness` 不继承。
 */
const INHERITED_FIELDS: ReadonlySet<LayerField> = new Set(["origin", "angles", "scale", "visible", "parallaxDepth"]);

export type WriteResult = "applied" | "recompile";

export interface DirtyState {
  layers: Set<number>;
  passes: Set<TargetKey>;
  bloom: boolean;
  /** effect 开关变了的图层（`objects` 下标）：渲染图可能要重排（3c）。 */
  structures: Set<number>;
  /** `ambientcolor` / `skylightcolor` 写过：刷进声明了这两个 uniform 的 draw（L5）。 */
  lights: boolean;
  /** `instanceoverride` 改过的粒子层（`objects` 下标）：交给模拟器从基值重新乘（P4a 步骤 5）。 */
  particles: Set<number>;
}

/** 一个 effect 的运行时开关；`unsupported`：带不支持项，打开要整场重编译（不算可变，见 `variantPlans`）。 */
interface EffectState {
  enabled: boolean;
  unsupported: boolean;
}

/** effect 开关的键：scene.json 坐标（`effect` 是 `SceneEffect.source`，不是 `layer.effects` 下标）。 */
function effectKey(object: number, effect: number): string {
  return `${object}/${effect}`;
}

/** 有 `condition` 时值换成布尔，按字符串比（I3）。 */
/**
 * 脚本写回的值（运行时已按目标类型铺满、`[x, y, z]` 或布尔）→ `SceneState.write` 收的值。WPE 的脚本写回走类型化 setter，
 * 直接写 float（vector-constant-REPORT.md 2.6）：单分量传数字（材质的 float setter 不收字符串），多分量拼成空格分隔的字符串，
 * 向量 setter 再按空格切回同样的分量。
 */
export function scriptWriteValue(value: number[] | boolean): SceneScalar {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : value.join(" ")) : value;
}

/** `constant` 目标的各格取值方式；手写的目标没有 `members` 时每格按 `type` 取满。 */
function constantMembers(target: Extract<BindingTarget, { kind: "constant" }>): MaterialMember[] {
  if (target.members) return target.members;
  const n = target.type === "vec2" ? 2 : target.type === "vec3" ? 3 : target.type === "vec4" ? 4 : 1;
  return target.uniforms.map((name) => ({ name, size: n, components: n, count: n, default: undefined }));
}

function conditioned({ condition }: SceneBinding, raw: SceneScalar): SceneScalar {
  return condition === undefined ? raw : String(raw) === condition;
}

/** `general.bloom` 的写入值：WPE 的 setter 只认 bool，别的值不改位（G4），同 `flagValue`；不改位时返回 undefined。 */
function bloomFlagOf(binding: SceneBinding, raw: SceneScalar): boolean | undefined {
  const value = conditioned(binding, raw);
  return typeof value === "boolean" ? value : undefined;
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
    parallaxDepth: [...layer.parallaxDepth],
    parent: layer.parent,
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
  // 缺键与解析不出分量时同编译期（`bundle.ts`）
  parallaxDepth: [1, 1],
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
  /** 场景的 bloom 位，不含档位（WPE 的 `+0xe0` bit1）。档位关闭时没有泛光链，位怎么变都没有效果。 */
  bloomEnabled: boolean;
  /** 起始值 = `bundle.general.fields`。清屏两项不标脏，`encode` 每帧读（L4）。 */
  general: GeneralValues;
  /**
   * 粒子层的 `instanceoverride` 标量（`objects` 下标 → 值），起始值 = 编译期的 `particle.instance`（P4a 步骤 5）。
   * 只是数据：`GpuScene.sync` 把脏的交给模拟器（`ParticleSystem.setInstance`）。
   */
  readonly particleInstances = new Map<number, ParticleInstanceValues>();
  /**
   * 声音对象的就地值（P6a 步骤 1，`objects` 下标 → 值），起始值 = 编译期的 `SceneSound.volume`。写入不标脏：宿主的排期器
   * 每帧读（`audio/sceneSounds.ts`），值变了才走 WPE 的音量回调。
   */
  readonly sounds = new Map<number, { volume: number }>();
  private dirtyLayers = new Set<number>();
  private dirtyPasses = new Set<TargetKey>();
  private bloomDirty = false;
  private dirtyStructures = new Set<number>();
  private lightsDirty = false;
  private dirtyParticles = new Set<number>();
  /** 可变 effect 加载时没备好的图层：切换走整场重编译。 */
  private readonly frozenLayers = new Set<number>();

  private constructor(
    layers: Map<number, LayerState>,
    constants: Map<TargetKey, Record<string, number[]>>,
    bloom: BloomParams,
    private readonly effects: Map<string, EffectState>,
    bloomEnabled: boolean,
    /** 档位允许但没有编泛光链：打开要整场重编译。 */
    private readonly bloomMissing: boolean,
    general: GeneralValues,
    /** 父 → 直接子（都是 `objects` 下标，只含进了 bundle 的图层）：写父的变换或可见性时子孙一起标脏。 */
    private readonly children: Map<number, number[]>,
  ) {
    this.layers = layers;
    this.constants = constants;
    this.bloom = bloom;
    this.bloomEnabled = bloomEnabled;
    this.general = general;
  }

  static fromBundle(bundle: SceneBundle): SceneState {
    const layers = new Map<number, LayerState>();
    const constants = new Map<TargetKey, Record<string, number[]>>();
    const effects = new Map<string, EffectState>();
    const children = new Map<number, number[]>();
    const instances = new Map<number, ParticleInstanceValues>();
    for (const layer of bundle.layers) {
      layers.set(layer.object, layerStateOf(layer));
      if (layer.particle) instances.set(layer.object, instanceValues(layer.particle.instance));
      if (layer.parent !== null) {
        const list = children.get(layer.parent);
        if (list) list.push(layer.object);
        else children.set(layer.parent, [layer.object]);
      }
      for (const pass of layer.passes) constants.set(pass.key, { ...pass.uniforms });
      // 粒子材质的常量（P4a 步骤 4）：粒子 draw 的 uniform 同样从这里取，绑定也按 pass 键就地写；含系统树里的子系统（P4e 步骤 1）
      const addParticle = (particle: SceneParticle) => {
        for (const pass of particle.passes) constants.set(pass.key, { ...pass.uniforms });
        for (const child of particle.children ?? []) addParticle(child.system);
      };
      if (layer.particle) addParticle(layer.particle);
      for (const effect of layer.effects) {
        effects.set(effectKey(layer.object, effect.source), {
          enabled: effect.enabled,
          unsupported: effect.unsupported.length > 0,
        });
        for (const step of effect.steps)
          if (step.kind === "draw") constants.set(step.pass.key, { ...step.pass.uniforms });
      }
      if (layer.passthrough) constants.set(layer.passthrough.key, { ...layer.passthrough.uniforms });
    }
    const { bloom, postprocess, fields } = bundle.general;
    const state = new SceneState(
      layers,
      constants,
      { ...bloom, tint: [...bloom.tint] },
      effects,
      postprocess.bloomFlag,
      !bundle.bloom && postprocess.level !== "disabled",
      { ...fields },
      children,
    );
    for (const [object, values] of instances) state.particleInstances.set(object, values);
    // 手写的测试 bundle 可能没有声音表
    for (const sound of bundle.sounds ?? []) state.sounds.set(sound.object, { volume: sound.volume });
    return state;
  }

  /** 自身与全部子孙（`objects` 下标，自身在前）。环在编译期已断开，这里按走过的节点兜底。 */
  subtree(object: number): number[] {
    const out = [object];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++)
      for (const child of this.children.get(out[i]) ?? [])
        if (!seen.has(child)) {
          seen.add(child);
          out.push(child);
        }
    return out;
  }

  /** 按 scene.json 坐标取 effect 开关；不在 bundle 里的算关着。 */
  effectEnabled(object: number, effect: number): boolean {
    return this.effects.get(effectKey(object, effect))?.enabled ?? false;
  }

  /** `GpuScene.prepareVariants` 没能备好这一层：同一层的失败不细分到 effect，切这一层都走重编译。 */
  freezeLayer(object: number): void {
    this.frozenLayers.add(object);
  }

  /** 这次写入是否要整场重编译（不改状态）：打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景，或已经是重编译类目标。 */
  needsRecompile(binding: SceneBinding, raw: SceneScalar): boolean {
    const { target } = binding;
    if (target.kind === "recompile") return true;
    if (target.kind === "bloom-enabled")
      return this.bloomMissing && !this.bloomEnabled && bloomFlagOf(binding, raw) === true;
    if (target.kind !== "effect") return false;
    const effect = this.effects.get(effectKey(target.object, target.effect));
    const enabled = bindingValue(raw, binding.condition, "bool") !== false;
    if (!effect || enabled === effect.enabled) return false;
    return (effect.unsupported && enabled) || this.frozenLayers.has(target.object);
  }

  /**
   * 一条绑定的写入；目标不在当前 bundle 里（如被排除的 effect）返回 `"applied"` 且不做事，
   * 重编译类目标与 `needsRecompile` 为真的开关返回 `"recompile"`（调用方整场重编译）。状态不变，只有 bloom 位例外：
   * 脚本写完要能当场读回（K5），没有链时位开着也不画，整场编译后才打开。
   */
  write(binding: SceneBinding, raw: SceneScalar): WriteResult {
    const { target } = binding;
    if (target.kind === "recompile") return "recompile";
    if (target.kind === "script-property") return "applied";
    if (target.kind === "effect") {
      const effect = this.effects.get(effectKey(target.object, target.effect));
      if (!effect) return "applied";
      // 值换算同编译期（`enabled = 解析值 !== false`）
      const enabled = bindingValue(raw, binding.condition, "bool") !== false;
      if (enabled === effect.enabled) return "applied";
      if (this.needsRecompile(binding, raw)) return "recompile";
      effect.enabled = enabled;
      this.dirtyStructures.add(target.object);
      return "applied";
    }
    if (target.kind === "bloom-enabled") {
      const value = bloomFlagOf(binding, raw);
      if (value === undefined) return "applied";
      const recompile = this.needsRecompile(binding, raw);
      this.bloomEnabled = value;
      return recompile ? "recompile" : "applied";
    }
    if (target.kind === "general") {
      const value = generalValue(target.key, conditioned(binding, raw));
      if (value === undefined) return "applied";
      this.general = { ...this.general, [target.key]: value };
      if (target.key === "ambientcolor" || target.key === "skylightcolor") this.lightsDirty = true;
      return "applied";
    }
    if (target.kind === "particle-instance") {
      const values = this.particleInstances.get(target.object);
      if (!values) return "applied";
      // 取值规则与编译期相同（`instanceColorn` / `instanceScalar`），条件先换成布尔
      if (target.field === "colorn") values.colorn = instanceColorn(conditioned(binding, raw));
      else values[target.field] = instanceScalar(conditioned(binding, raw));
      this.dirtyParticles.add(target.object);
      return "applied";
    }
    if (target.kind === "sound") {
      const sound = this.sounds.get(target.object);
      // 取值规则与编译期相同（`soundVolume`），条件先换成布尔；不合法的值不改字段（WPE 的 float 解析器不收时不写）
      const value = soundVolume(conditioned(binding, raw));
      if (sound && value !== undefined) sound.volume = value;
      return "applied";
    }
    if (target.kind === "layer") {
      const layer = this.layers.get(target.object);
      if (layer) {
        writeLayer(layer, target.field, bindingValue(raw, binding.condition, target.field));
        // 变换、可见性与视差深度传给子孙：子孙的世界矩阵与视差平移跟着变；alpha、color、brightness 只是自己的
        if (INHERITED_FIELDS.has(target.field))
          for (const object of this.subtree(target.object)) this.dirtyLayers.add(object);
        else this.dirtyLayers.add(target.object);
      }
      return "applied";
    }
    if (target.kind === "constant") {
      const constants = this.constants.get(target.pass);
      if (!constants) return "applied";
      // WPE 运行时把属性值交给编译期同一个 setter（vector-constant-REPORT.md 2.5）：带 condition 的换成布尔，材质 setter 不收
      // （第 6 节 `u-cond-f`）；不收的类型整格不动，收了就整体重写，不留旧分量（`materialValues.ts`）
      if (binding.condition !== undefined) return "applied";
      let changed = false;
      for (const member of constantMembers(target)) {
        const written = materialSetter(member.components, raw);
        if (!written) continue;
        constants[member.name] = memberValue(member, written);
        changed = true;
      }
      if (changed) this.dirtyPasses.add(target.pass);
      return "applied";
    }
    this.bloom = writeBloomParam(this.bloom, target.field, raw, binding.condition);
    this.bloomDirty = true;
    return "applied";
  }

  /** 渲染器每帧取走脏项（取走即清空）。 */
  takeDirty(): DirtyState {
    const dirty = {
      layers: this.dirtyLayers,
      passes: this.dirtyPasses,
      bloom: this.bloomDirty,
      structures: this.dirtyStructures,
      lights: this.lightsDirty,
      particles: this.dirtyParticles,
    };
    this.dirtyLayers = new Set();
    this.dirtyPasses = new Set();
    this.bloomDirty = false;
    this.dirtyStructures = new Set();
    this.lightsDirty = false;
    this.dirtyParticles = new Set();
    return dirty;
  }
}
