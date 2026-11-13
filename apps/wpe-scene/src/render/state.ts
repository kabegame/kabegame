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
 * 粒子（P4a 步骤 5）：`instanceoverride` 的标量、`colorn`（P4b 步骤 6）与控制点覆盖（P4f 步骤 3）存在 `particleInstances`，写入用编译期
 * 同一条取值规则（`instanceScalar` / `instanceColorn` / `instanceControlPointValue`）、标脏后由 `GpuScene.sync` 交给模拟器从基值重新乘、
 * 重算颜色平移、把控制点覆盖写进控制点。脚本 `layer.instance.<键>` 的读写也是这一份（WPE 的 `io`）。`rate` 例外（P4f 步骤 1，
 * rea-p4f-script.md 5.4）：WPE 的 `rate` 没有改值回调，写了不置脏，`sync` 只改步进率（不钳制、不重算）。用户属性、字段脚本的写回
 * 都走这里，所以两条入口一起是这个语义。
 *
 * 声音（P6a 步骤 1）：`volume` 存在 `sounds`，写入用编译期同一条取值规则（`soundVolume`），不标脏，宿主的排期器每帧读。
 *
 * 对齐（P8 步骤 3）：图层的自身偏移 `offset` 只作用在它自己的绘制上（`render/layout.ts` 的 `drawMatrixOf`），子孙的世界矩阵不带它。
 * 图像层按 `alignment` 与 `trunc(size)` 算（`alignmentOffset`，加载时与脚本写 `alignment` 时），文本层由排版填（下段）。
 *
 * 文本（P6b 1d）：排版结果存在 `texts`（宿主排好、加载时交来），对齐偏移写进图层的 `offset`。背景色是一份材质常量（文本表的
 * `background.key`），`backgroundcolor` 的就地写走 `constant` 目标；文本层的 effect 开关按冻结的图层处理（切换整场重编译）。
 * 1e：每层当前的排版字段存在 `textFields`（起始值 = 编译期的 `SceneText.fields`），文本目标的写入按来源规整好（属性走 `write` 的
 * 文本分支、脚本走 `writeText`），和现值逐项比较，变了才标 `dirtyTexts`（WPE `FUN_140256f20` 开头的比较表）；渲染器重排后经
 * `setText` 换上新排版。
 */
import { ALIGNMENTS } from "../compile/alignment";
import {
  bindingValue,
  generalValue,
  isLayerVectorField,
  layerVectorValue,
  type BindingTarget,
  type GeneralValues,
  type LayerField,
  type SceneBinding,
  type TargetKey,
  type TextRuntimeField,
} from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { materialSetter, memberValue, type MaterialMember } from "../compile/materialValues";
import type { SceneScalar } from "../compile/model";
import {
  INSTANCE_RATE_MIN,
  instanceColorn,
  instanceControlPoint,
  instanceControlPointValue,
  instanceScalar,
  instanceValues,
  type InstanceField,
  type ParticleInstanceValues,
  type SceneParticle,
} from "../compile/particles";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import { soundVolume } from "../compile/sounds";
import { sameTextField, textFieldFromJson, type TextFields } from "../text/fields";
import type { TextLayout } from "../text/layout";
import { alignmentOffset } from "./layout";

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
  /**
   * 自身偏移（P8 步骤 3）：图层画自己时在世界矩阵后右乘 `T(offset)`（`render/layout.ts` 的 `drawMatrixOf`），子孙不带。文本层是排版
   * 的对齐偏移（P6b 1d，`TextLayout.offset`，由 `setTexts`（加载）与 `setText`（1e 运行中重排）填）；图像层是对齐
   * （`alignmentOffset(alignment, trunc(size))`，`fromBundle` 与脚本写 `alignment` 时算，为 (0, 0) 时不写）。其它图层没有。
   */
  offset?: [number, number];
  /**
   * 对齐（P8 步骤 3，`SceneLayer.alignment`，`compile/alignment.ts` 的下标）：只有图像层有。脚本写 `thisLayer.alignment` 时改它并重算
   * `offset`（`SceneState.write`）。
   */
  alignment?: number;
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
  /** 排版字段变了的文本层（`objects` 下标，P6b 1e）：渲染器按 `textFields` 重排。 */
  texts: Set<number>;
  /**
   * 写过 `instanceoverride.rate` 的粒子层（P4f 步骤 1，rea-p4f-script.md 5.4）：`rate` 没有改值回调，不进 `particles`，`GpuScene.sync`
   * 只改模拟器的步进率（`ParticleSystem.setRate`），先于 `particles` 的重算。同一个对象可以两边都有。
   */
  rates: Set<number>;
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
export function scriptWriteValue(value: number[] | boolean | string): SceneScalar {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : value.join(" ")) : value;
}

/** 编译期文本字段的一份拷贝：向量不与 bundle 共用（运行中按字段改写）。 */
function copyTextFields(fields: TextFields): TextFields {
  return {
    ...fields,
    padding: [fields.padding[0], fields.padding[1]],
    spacing: [fields.spacing[0], fields.spacing[1]],
  };
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
  const state: LayerState = {
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
  // 图像层的对齐（P8 步骤 3）：`layer.size` 已是 autosize / fullscreen 之后的尺寸；偏移为 0 时不写，没有对齐的图层字节不变
  if (layer.alignment !== undefined) {
    state.alignment = layer.alignment;
    const offset = alignmentOffset(layer.alignment, layer.size);
    if (offset[0] !== 0 || offset[1] !== 0) state.offset = offset;
  }
  return state;
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

/** 图层字段的缺省值（与编译期 `numbers(resolveValue(…), 缺省)` 同一套：解析不出分量时退回）。`alignment` 另写（`writeAlignment`）。 */
const LAYER_DEFAULTS: Record<Exclude<LayerField, "visible" | "alignment">, number[]> = {
  origin: [0, 0, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0],
  alpha: [1],
  color: [1, 1, 1],
  brightness: [1],
  // 缺键与解析不出分量时同编译期（`bundle.ts`）
  parallaxDepth: [1, 1],
};

function writeLayer(layer: LayerState, field: Exclude<LayerField, "alignment">, value: number[] | boolean): void {
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
   * 粒子层的 `instanceoverride` 标量（`objects` 下标 → 值），起始值 = 编译期的 `particle.instance`（P4a 步骤 5），`rate` 钳过
   * （加载时 WPE 钳一次并写回，rea-p4f-script.md 6.1）。就是 WPE 的 `io`（脚本 `instance` 对象读写的那一份）：
   * 只是数据，`GpuScene.sync` 把脏的交给模拟器（`ParticleSystem.setInstance`），重算里钳过的 `rate` 写回这里（5.2）；只写了 `rate`
   * 的交给 `ParticleSystem.setRate`，这里保留原值（5.4）。
   */
  readonly particleInstances = new Map<number, ParticleInstanceValues>();
  /**
   * 声音对象的就地值（P6a 步骤 1，`objects` 下标 → 值），起始值 = 编译期的 `SceneSound.volume`。写入不标脏：宿主的排期器
   * 每帧读（`audio/sceneSounds.ts`），值变了才走 WPE 的音量回调。
   */
  readonly sounds = new Map<number, { volume: number }>();
  /**
   * 文本层的排版结果（P6b 1d，`objects` 下标 → `TextLayout`，含字形网格与它所在的图集）：宿主在加载前排好（`text/host.ts`），经
   * `GpuScene.build` 的 `texts` 交来（`setTexts`）。渲染图按它定文字框、合成 RT 与有没有彩色字形，世界矩阵带它的对齐偏移。
   * 1e 起运行中重排后由 `setText` 换上新的。
   */
  readonly texts = new Map<number, TextLayout>();
  /**
   * 文本层当前的排版字段（P6b 1e，`objects` 下标 → `TextFields`），起始值 = 编译期的 `SceneText.fields`（拷贝）。文本目标的写入改它，
   * 和现值逐项比较，变了才标 `dirtyTexts`；渲染器按它重排，排完的结果经 `setText` 进 `texts`。
   */
  readonly textFields = new Map<number, TextFields>();
  /** bundle 里的文本图层（`SceneLayer.text` 非空，`objects` 下标）。 */
  private readonly textObjects = new Set<number>();
  /** 图像层（`SceneLayer.alignment` 有值）的 `size`（P8 步骤 3）：脚本写 `alignment` 时按它重算偏移；尺寸只在重编译时变。 */
  private readonly alignmentSizes = new Map<number, readonly number[]>();
  private dirtyLayers = new Set<number>();
  private dirtyPasses = new Set<TargetKey>();
  private bloomDirty = false;
  private dirtyStructures = new Set<number>();
  private lightsDirty = false;
  private dirtyParticles = new Set<number>();
  private dirtyTexts = new Set<number>();
  private rateParticles = new Set<number>();
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
      // 模型网格材质的常量（P5c 步骤 2）：网格 draw 的 uniform 同样从这里取（retro 的 `g_Tint`），属性绑定按 pass 键就地写
      for (const mesh of layer.model?.meshes ?? [])
        for (const pass of mesh.passes) constants.set(pass.key, { ...pass.uniforms });
      for (const effect of layer.effects) {
        effects.set(effectKey(layer.object, effect.source), {
          enabled: effect.enabled,
          unsupported: effect.unsupported.length > 0,
        });
        for (const step of effect.steps)
          if (step.kind === "draw") constants.set(step.pass.key, { ...step.pass.uniforms });
      }
      if (layer.passthrough) constants.set(layer.passthrough.key, { ...layer.passthrough.uniforms });
      // 组的上屏（P5b 步骤 4）：同 passthrough，g_Color4 由材质值置 1
      if (layer.groupUpload) constants.set(layer.groupUpload.key, { ...layer.groupUpload.uniforms });
      // 文本的四个宿主 pass（P6b 1d）。背景常量总要有一份：没有背景 pass（合成路径清屏）时清屏色同样从它读，`backgroundcolor` 的
      // 就地写落在这里
      const text = layer.text;
      if (text) {
        for (const pass of [text.glyphPass, text.colorPass, text.backgroundPass, text.clearAlphaPass])
          if (pass) constants.set(pass.key, { ...pass.uniforms });
        if (!constants.has(text.background.key))
          constants.set(text.background.key, { g_Color: [...text.background.color] });
      }
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
    // 加载时 `rate` 钳到 0.01 并写回（`FUN_14022af30` `0x14022b840`–`0x14022b86f`，rea-p4f-script.md 6.1）：脚本 `init` 读到的就是钳过的
    // 值，和建系统时（`ParticleSystem` 构造）的钳制一致
    for (const [object, values] of instances)
      state.particleInstances.set(object, { ...values, rate: Math.max(INSTANCE_RATE_MIN, values.rate) });
    for (const layer of bundle.layers)
      if (layer.alignment !== undefined) state.alignmentSizes.set(layer.object, [...layer.size]);
    // 手写的测试 bundle 可能没有声音表
    for (const sound of bundle.sounds ?? []) state.sounds.set(sound.object, { volume: sound.volume });
    // 文本层的 effect 开关会改 `padding`、文字框与合成 RT（rea-p6b-layout 3.5），1d 没有就地重排：切换一律整场重编译（同冻结的图层）
    for (const layer of bundle.layers)
      if (layer.text) {
        state.textObjects.add(layer.object);
        state.textFields.set(layer.object, copyTextFields(layer.text.fields));
        state.freezeLayer(layer.object);
      }
    return state;
  }

  /**
   * 文本字段的写入（P6b 1e）：`value` 已按来源规整（属性 `textFieldFromJson`、脚本 `textFieldFromScript`），undefined 表示不写。
   * 值没变不标脏、不重排（同 WPE 的逐项比较：脚本每帧返回同一串时不重排）。不是 bundle 里的文本层时不做事。
   */
  writeText<F extends TextRuntimeField>(object: number, field: F, value: TextFields[F] | undefined): void {
    const fields = this.textFields.get(object);
    if (!fields || value === undefined || sameTextField(fields[field], value)) return;
    // 向量存一份拷贝，不与调用方共用
    fields[field] = (Array.isArray(value) ? [...value] : value) as TextFields[F];
    this.dirtyTexts.add(object);
  }

  /**
   * 不改字段、只把这一层标进 `dirtyTexts`（P6b 1e）：运行中重排缺的字体读完了（宿主收到 `SceneTexts` 的 `onReady`），下一次 `sync`
   * 按当前字段再排一次。不是 bundle 里的文本层时不做事（回调到达时场景可能已经换了）。
   */
  touchText(object: number): void {
    if (this.textFields.has(object)) this.dirtyTexts.add(object);
  }

  /**
   * 换上一层运行中重排的结果（P6b 1e，渲染器处理 `dirty.texts` 时调）：记下 `TextLayout`、写对齐偏移；偏移变了，本层画自己的矩阵跟着变，
   * 标进脏图层。子孙的世界矩阵不带它（P8 步骤 3，`p8-align2` 的 Xc），文本层也不会是组，所以只标本层。不是 bundle 里的文本层时不做事。
   */
  setText(object: number, layout: TextLayout): void {
    const layer = this.layers.get(object);
    if (!layer || !this.textObjects.has(object)) return;
    this.texts.set(object, layout);
    const [x, y] = layout.offset;
    const previous = layer.offset;
    layer.offset = [x, y];
    if (!previous || previous[0] !== x || previous[1] !== y) this.dirtyLayers.add(object);
  }

  /**
   * 换上文本层的排版结果（P6b 1d，`GpuScene.build` 调）：记下每层的 `TextLayout`，图层的对齐偏移写进 `LayerState.offset`。只认
   * bundle 里的文本图层，其余条目忽略。
   */
  setTexts(layouts: ReadonlyMap<number, TextLayout>): void {
    for (const [object, layout] of layouts) {
      const layer = this.layers.get(object);
      if (!layer || !this.textObjects.has(object)) continue;
      this.texts.set(object, layout);
      layer.offset = [layout.offset[0], layout.offset[1]];
    }
  }

  /**
   * 脚本写图像层的 `alignment`（P8 步骤 3，rea-p8-layer 2.4，`p8-par` 的 T）：`value` 的第一个分量是 `ALIGNMENTS` 的下标（脚本侧已按
   * `alignmentIndex` 换好，字符串查不到、非字符串都是 0），不是合法下标时按 `center`。改下标、按 `trunc(size)` 重算偏移（为 0 时去掉），
   * 偏移变了才标脏。WPE 写完回调重建四边形与偏移、下一次绘制生效；我们就地改、`sync` 当帧刷，同帧生效。标整棵子树：子孙的世界矩阵不
   * 带它，但图层是组时子孙画进组的局部正交，那是按组画自己的矩阵算的（`groupViewProjection`）。不是图像层（没有 `alignment`）时不做事。
   */
  private writeAlignment(object: number, layer: LayerState, value: number[] | boolean): void {
    const size = this.alignmentSizes.get(object);
    if (layer.alignment === undefined || !size) return;
    const first = Array.isArray(value) ? value[0] : undefined;
    const index = first !== undefined && Number.isInteger(first) && first >= 0 && first < ALIGNMENTS.length ? first : 0;
    layer.alignment = index;
    const [x, y] = alignmentOffset(index, size);
    const [px = 0, py = 0] = layer.offset ?? [];
    if (x === 0 && y === 0) delete layer.offset;
    else layer.offset = [x, y];
    if (px !== x || py !== y) for (const item of this.subtree(object)) this.dirtyLayers.add(item);
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
    // 文本字段就地写、渲染器重排（P6b 1e）：从不整场重编译
    if (target.kind === "text") return false;
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
      // 取值规则与编译期相同（`instanceColorn` / `instanceControlPointValue` / `instanceScalar`），条件先换成布尔。控制点覆盖
      // （P4f 步骤 3，rea-p4f-script.md 5.5）换一份新数组，不改编译期那份
      const point = instanceControlPoint(target.field);
      if (point) {
        const key = point.angle ? "controlpointAngles" : "controlpoints";
        const list = [...values[key]];
        list[point.index] = instanceControlPointValue(conditioned(binding, raw));
        values[key] = list;
      } else if (target.field === "colorn") values.colorn = instanceColorn(conditioned(binding, raw));
      else values[target.field as InstanceField] = instanceScalar(conditioned(binding, raw));
      // `rate` 没有改值回调（rea-p4f-script.md 5.4，用户属性同样，P3 I3）：写了不置脏、不钳制，`sync` 只改步进率；其余键调
      // `0x14022ab30` 置脏（5.1），下一帧开头从基值重算（5.2、5.3）
      if (target.field === "rate") this.rateParticles.add(target.object);
      else this.dirtyParticles.add(target.object);
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
      const { field } = target;
      // 对齐（P8 步骤 3）只给脚本写：换下标、重算自身偏移（`writeAlignment`）
      if (layer && field === "alignment") {
        this.writeAlignment(target.object, layer, bindingValue(raw, binding.condition, field));
        return "applied";
      }
      if (layer && field !== "alignment") {
        // 向量字段（origin / scale / color / parallaxDepth）照 WPE 的向量 setter，同编译期（`layerVectorValue`，P6b 1e-3 复核）：
        // 数字铺满、字符串少写的分量为 0；写不进（布尔）时 WPE 不改字段，这里也不写、不标脏
        if (isLayerVectorField(field)) {
          const vector = layerVectorValue(field, conditioned(binding, raw));
          if (!vector) return "applied";
          writeLayer(layer, field, vector);
        } else writeLayer(layer, field, bindingValue(raw, binding.condition, field));
        // 变换、可见性与视差深度传给子孙：子孙的世界矩阵与视差平移跟着变；alpha、color、brightness 只是自己的
        if (INHERITED_FIELDS.has(field)) for (const object of this.subtree(target.object)) this.dirtyLayers.add(object);
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
    if (target.kind === "text") {
      // 属性侧取值规则与编译期相同（`textFieldFromJson`：`text` 只收字符串），条件先换成布尔
      this.writeText(target.object, target.field, textFieldFromJson(target.field, conditioned(binding, raw)));
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
      texts: this.dirtyTexts,
      rates: this.rateParticles,
    };
    this.dirtyLayers = new Set();
    this.dirtyPasses = new Set();
    this.bloomDirty = false;
    this.dirtyStructures = new Set();
    this.lightsDirty = false;
    this.dirtyParticles = new Set();
    this.dirtyTexts = new Set();
    this.rateParticles = new Set();
    return dirty;
  }
}
