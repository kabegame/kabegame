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
 * 相机对象（P5d 步骤 3）：`fov` / `zoom` 存在 `cameras`，写入用编译期同一条取值规则（`cameraValue`），不标脏，渲染器每帧选相机时读
 * （`render/camera.ts` 的 `activeCameraObject`）。相机的变换与可见性就是图层的 `origin` / `angles` / `scale` / `visible`。
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
import { isFogUniformField } from "../compile/fog";
import {
  bindingValue,
  cameraValue,
  generalValue,
  isLayerVectorField,
  layerVectorValue,
  lightFieldValue,
  type BindingTarget,
  type CameraBaseField,
  type GeneralValues,
  type LayerField,
  type LightField,
  type LightValues,
  type SceneBinding,
  type TargetKey,
  type TextRuntimeField,
} from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { SceneLightObject } from "../compile/lights";
import type { SceneSound } from "../compile/sounds";
import { DEFAULT_CAMERA } from "../compile/camera";
import { materialSetter, memberValue, type MaterialMember } from "../compile/materialValues";
import type { SceneScalar } from "../compile/model";
import type { LayerShellValues } from "../compile/layerShell";
import { normalizePassState, type PassStateField } from "../compile/passState";
import {
  INSTANCE_RATE_MIN,
  instanceColorn,
  instanceControlPoint,
  instanceControlPointValue,
  instanceScalar,
  instanceValues,
  particleDraws,
  type InstanceField,
  type ParticleInstanceValues,
  type SceneParticle,
} from "../compile/particles";
import { BLOOM_DEFAULTS, type BloomParams } from "../compile/postprocess";
import { soundVolume } from "../compile/sounds";
import { animationLayerValue } from "../compile/puppet";
import { animationLayerKey, type PuppetLayerFields } from "../puppet/player";
import { sameTextField, textFieldFromJson, type TextFields } from "../text/fields";
import type { TextLayout } from "../text/layout";
import type { CameraPose } from "./camera";
import { alignmentOffset } from "./layout";

const f32 = Math.fround;

/** 正交且没有路径的场景，加载末尾把相机基准重置成的值（rea-p5-camera / p3 L2）：视图恒为单位阵。 */
export const ORTHOGRAPHIC_CAMERA_BASE: Readonly<Pick<CameraPose, "eye" | "center" | "up">> = {
  eye: [0, 0, 0],
  center: [0, 0, -1],
  up: [0, 1, 0],
};

/** 脚本 `init` 之前相机基准的构造缺省值（eye (2,2,2)、center (0,0,0)、up (0,1,0)、zoom 1；WPE 先跑 `init`、后读 `scene.json` 的 `camera`）。 */
export function constructedCameraBase(): CameraPose {
  return { eye: [...DEFAULT_CAMERA.eye], center: [...DEFAULT_CAMERA.center], up: [...DEFAULT_CAMERA.up], zoom: 1 };
}

/** 相机基准的两份拷贝用的深拷贝（运行中改它不动 bundle）。 */
function copyCameraPose(pose: CameraPose): CameraPose {
  return { eye: [...pose.eye], center: [...pose.center], up: [...pose.up], zoom: pose.zoom };
}

export interface LayerState {
  /** angles 为弧度（同 scene.json）。都是本地值：世界矩阵与继承后的可见性按父链现算（`render/layout.ts`）。 */
  origin: number[];
  scale: number[];
  angles: number[];
  /**
   * 3×3 旋转（9 个 f32，列主序 `R[3c + r]`；P6d1a，rea-p6d1-xform 2.5）：WPE 画面与世界矩阵只读它，角度写入先存角度再按 `Rz·Ry·Rx` 重建；
   * 只有 `rotateObjectSpace` 直接乘它并把角度反算回去，两份在末位上分开。`null` / 缺省 = 按 `angles` 现算（`layerLocalMatrix`），
   * 任何 `angles` 写入都清成 `null`。
   */
  rotation?: number[] | null;
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
  /**
   * 光标命中的开关（P6c，`SceneLayer.solid`；缺省真，`undefined` 也当真）：命中测试每帧现读，没有改值回调（p6-REPORT 0c）。对所有对象类型
   * 都能读写，但只有图像层与文本层参与命中。脚本写 `thisLayer.solid`、字段脚本写回、用户属性绑定都落在这里，不标脏（不影响绘制）。
   */
  solid?: boolean;
  /**
   * 透视覆盖的开关（P5h，`SceneLayer.perspective`）：脚本写 `thisLayer.perspective`（只有图像层含组合层与文本层有这个键，只收布尔）才有值；
   * `undefined` = 取编译期的 `layer.perspective`。渲染与光标命中每次现读（`p5h-a` 实测：写入当帧生效）；uniform 只在标脏时重写，
   * 所以写入标这一个图层脏（`SceneState.write`）。
   */
  perspective?: boolean;
  /** 父对象的 `objects` 下标（`SceneLayer.parent`），根节点为 null。运行中由 `setParent` / 删父（`flushDestroy`）改。 */
  parent: number | null;
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
  /** `ambientcolor` / `skylightcolor`（L5）与雾的数值字段（P13f）写过：刷进声明了对应 uniform 的 draw。 */
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
  /**
   * 写过（或解码完成）的用户纹理属性来源（P11b 步骤 2，属性名）：`GpuScene.sync` 重新解析用到它的槽——换 bind group 与
   * `g_Texture<n>Resolution`，槽 0 整层重建。写入当场进来（RT 参考的槽从第一次写入起才生效，M8），解码完成再进一次。
   */
  userTextures: Set<string>;
  /**
   * 写过材质状态字段（`blending` 等五个）的图层（`objects` 下标，P6d1b）：`GpuScene.sync` 强制重建，规划时取 bundle 值加 `passStates` 的覆盖。
   * 只在写入时进来（WPE 每次绑定现读字节、没有「变没变」的判断，同值也重建一次无妨，但不每帧重建）。
   */
  passStates: Set<number>;
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
    rotation: null, // 按角度现算；只有 rotateObjectSpace 会写（P6d1a）
    alpha: layer.alpha,
    color: [...layer.color],
    brightness: layer.brightness,
    visible: layer.visible,
    parallaxDepth: [...layer.parallaxDepth],
    solid: layer.solid !== false,
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

/**
 * 按图层壳的取值建图层状态（P6d3b，运行时 `createLayer` 的待编对象）：字段与 `layerStateOf` 同一份。`imageLayer` 为真时带 `alignment`
 * （图像层才有）；偏移要尺寸，编译前 `shell.size` 为空就不写（已知差异：编完用编译产物的状态重放）。
 */
export function layerStateFromShell(
  shell: LayerShellValues,
  parent: number | null,
  options: { imageLayer?: boolean } = {},
): LayerState {
  const state: LayerState = {
    origin: [...shell.origin],
    scale: [...shell.scale],
    angles: [...shell.angles],
    rotation: null,
    alpha: shell.alpha,
    color: [...shell.color],
    brightness: shell.brightness,
    visible: shell.visible,
    parallaxDepth: [...shell.parallaxDepth],
    solid: shell.solid,
    parent,
  };
  if (options.imageLayer) {
    state.alignment = shell.alignment;
    if (shell.size.length >= 2) {
      const offset = alignmentOffset(shell.alignment, shell.size);
      if (offset[0] !== 0 || offset[1] !== 0) state.offset = offset;
    }
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
const LAYER_DEFAULTS: Record<Exclude<LayerField, "visible" | "alignment" | "solid" | "perspective">, number[]> = {
  origin: [0, 0, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0],
  alpha: [1],
  color: [1, 1, 1],
  brightness: [1],
  // 缺键与解析不出分量时同编译期（`bundle.ts`）
  parallaxDepth: [1, 1],
};

function writeLayer(
  layer: LayerState,
  field: Exclude<LayerField, "alignment" | "solid" | "perspective">,
  value: number[] | boolean,
): void {
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

/**
 * 状态需要的对象切片（L3a）：图层、声音、灯，是 `ObjectFragment` 的子集（`ObjectFragment` 可以直接当它用）。
 * `addObject` / `replaceObject` 与 `fromBundle` 的循环体共用这一份输入。
 */
export interface ObjectStateSlice {
  layer: SceneLayer;
  sound?: SceneSound;
  light?: SceneLightObject;
}

/** 一个对象在按键存放的表里占的键（`dropObject` / `replaceObject` 用，不依赖键的写法）。 */
interface OwnedKeys {
  /** `constants` 的 pass 键（`passStates` 同键） */
  constants: TargetKey[];
  /** `effects` 的键 */
  effects: string[];
  /** `shadowPasses` 的键（基础 pass 键） */
  shadow: TargetKey[];
}

/** 图层的 `ITextureAnimation` 私有状态（P6e 点 3，WPE 的 `A`）：`rate` 存 f32；`frame` 是 int，可越界、可负；`time` 是格内已过的秒。 */
export interface TextureAnimationState {
  detached: boolean;
  playing: boolean;
  rate: number;
  frame: number;
  time: number;
}

export class SceneState {
  /** 按 `objects` 下标（稳定键）；只含进了 bundle 的图层。 */
  readonly layers = new Map<number, LayerState>();
  /**
   * WPE 的对象表（`G+0x158`，P6d3）：全部对象键（含灯、声音、相机、分组节点、子对象），顺序 = 绘制顺序 = 脚本的原始下标。
   * 加载时 = `bundle.layers` 的顺序。`sortLayer` 改它；`flushDestroy` 生效时摘掉；P6d3b 起新建的追加在尾。
   */
  readonly order: number[] = [];
  /** `destroyLayer` 标记、还没生效的对象（rea-p6d-layers 第 5 节）；按标记先后。下标 API 按它扣减。 */
  readonly pendingDestroy = new Set<number>();
  /** 结构代数：`order`、父子、存活每变一次加一。渲染侧按它重建派生表（顶层顺序、位置表、命中表）并清理被删对象的资源。 */
  structureVersion = 0;
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
   * 灯对象的数值字段（P13f2，`objects` 下标 → `LightValues`），起始值 = 编译期的 `SceneLightObject.values`。写入不标脏：渲染器每帧现算
   * 灯光 uniform、遗留灯与体积光（WPE 这些字段没有改值回调，逐帧读，rea-p13-lights 3.1）。
   */
  readonly lights = new Map<number, LightValues>();
  /**
   * 相机对象的就地值（P5d 步骤 3，`objects` 下标 → 值），起始值 = 编译期的 `SceneLayer.camera`；只含 `camera` 非空的图层（纯相机对象）。
   * 写入不标脏：渲染器每帧选相机时读。
   */
  readonly cameras = new Map<number, { fov: number; zoom: number }>();
  /**
   * 场景相机的基准姿态（P5e，WPE `G+0x118`…`+0x13c`，`thisScene.get/setCameraTransforms` 读写的就是它），值按 float32 存。起始值 = 加载完成值
   * （正交 = 重置值 (0,0,0) / (0,0,−1) / (0,1,0)、透视 = `scene.json` 解析值，zoom 都是 1）；脚本 `init` 之前宿主调 `beginScriptInit` 换成构造缺省值，
   * `init` 之后调 `finishScriptInit` 套 `scene.json`。不标脏：渲染器每帧求相机时读（`render/camera.ts` 的 `sceneCameraFrame`）。
   */
  cameraBase: CameraPose = constructedCameraBase();
  /** 加载完成值与 `init` 之后被 `scene.json` 覆盖的字段（`finishScriptInit` 用）。 */
  private cameraLoaded: { pose: CameraPose; overridden: readonly CameraBaseField[] } = {
    pose: constructedCameraBase(),
    overridden: [],
  };
  /**
   * puppet 动画层的就地字段（P12a 步骤 3 点 3，键 `animationLayerKey(对象下标, 层 id)`，P12e：编译期的层 id = `animationlayers` 的 JSON 下标，运行时建的层是负数），起始值 = 编译期的 `PuppetLayerDef`（已按属性值解析）。
   * 写入不标脏：`ScenePuppets.frame` 每帧经 `animationLayer` 读，用户属性在两帧之间写进来、puppet 当帧就读到（p12-REPORT 用例 4）。
   */
  readonly animationLayers = new Map<string, PuppetLayerFields>();
  /**
   * 图层的 `ITextureAnimation` 私有状态（P6e 点 3，WPE 的 `A`，键 = `objects` 下标）：脚本第一次 `getTextureAnimation()` 时建，对象只是读写它的外壳。
   * `detached` 的图层画自己的 `frame`、每帧按 `rate` 私有推进（`GpuScene.stepParticles`，不看可见性）；否则跟共享计时器。随对象删除清掉
   * （`clearTables`），单对象重编译保留（`replaceObject`），整场重编译由 `adoptTextureAnimations` 接过；槽 0 换成用户纹理时由渲染器删（`dropTextureAnimation`）。
   * 条目对象本身是 API 外壳的身份：条目被删或换成别的对象，外壳即作废。
   */
  readonly textureAnimations = new Map<number, TextureAnimationState>();
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
  /** 直接写过变换的对象（不含子孙，B1）：影子缓存（`WorldStamps`）在下一个求值时刻清它们的戳（`GpuScene` 取走）。 */
  private transformWrites = new Set<number>();
  private dirtyPasses = new Set<TargetKey>();
  private bloomDirty = false;
  private dirtyStructures = new Set<number>();
  private lightsDirty = false;
  private dirtyParticles = new Set<number>();
  private dirtyTexts = new Set<number>();
  private rateParticles = new Set<number>();
  private dirtyUserTextures = new Set<string>();
  private dirtyPassStates = new Set<number>();
  /**
   * 脚本写过的材质状态字段（P6d1b，pass 稳定键 → 字段 → 规范名）：只存写过的字段，没写过的取 bundle 的 `ScenePass`（`render/passState.ts` 的
   * `applyPassStates` 拼出有效的 pass）。值已按字段的表规整。
   */
  readonly passStates = new Map<TargetKey, Partial<Record<PassStateField, string>>>();
  /**
   * 用户纹理属性来源的当前值（P11b 步骤 2，属性名 → 路径）：只存值，不存 GPU 资源。运行中写入才有项；加载时的初值在宿主的来源表里
   * （`usertex/sources.ts`）。值只认字符串，别的类型当空串（缺省纹理，p11-REPORT / rea-p11-textures：属性不是 `scenetexture` 时永远缺省）。
   */
  readonly userTextures = new Map<string, string>();
  /**
   * 加载之后真正写过的用户纹理属性来源（只增）：`write` 的 `user-texture` 分支记，解码完成（`touchUserTexture`）不记。`GpuScene` 的 RT 参考槽
   * 以它为门闸（M8：加载时就有值的不生效，运行中第一次写入之后才生效）。
   */
  readonly userWritten = new Set<string>();
  /**
   * 宿主登记的监听：用户纹理属性来源写入时同步调（名字与规整后的值），宿主交给来源表异步解码。`write` 不等解码，解码完成由宿主 `touchUserTexture`。
   */
  onUserTexture: ((name: string, value: string) => void) | null = null;
  /** 可变 effect 加载时没备好的图层：切换走整场重编译。 */
  private readonly frozenLayers = new Set<number>();
  /** 模型网格第一个 pass 的键 → 它的阴影投射变体的键（P13d，`SceneMesh.shadow`）：基础常量写入时同步写变体。 */
  private shadowPasses = new Map<TargetKey, TargetKey>();
  /** 每个对象在按键存放的表里占的键（L3a）：`dropObject` / `replaceObject` 按它清，不靠键的写法。 */
  private readonly owned = new Map<number, OwnedKeys>();
  /** effect 开关表（键见 `effectKey`）；对象的项由 `installTables` 写、`clearTables` 清。 */
  private readonly effects = new Map<string, EffectState>();
  /** 子表（WPE `O+0x198`）：父 → 直接子（都是 `objects` 下标，只含进了 bundle 的图层）。写父的变换或可见性时子孙一起标脏；换父挂上的追加在尾。 */
  private readonly children = new Map<number, number[]>();

  private constructor(
    bloom: BloomParams,
    bloomEnabled: boolean,
    /** 档位允许但没有编泛光链：打开要整场重编译。 */
    private readonly bloomMissing: boolean,
    general: GeneralValues,
  ) {
    this.bloom = bloom;
    this.bloomEnabled = bloomEnabled;
    this.general = general;
  }

  static fromBundle(bundle: SceneBundle): SceneState {
    const { bloom, postprocess, fields } = bundle.general;
    const state = new SceneState(
      { ...bloom, tint: [...bloom.tint] },
      postprocess.bloomFlag,
      !bundle.bloom && postprocess.level !== "disabled",
      { ...fields },
    );
    // 子表以编译产物为准（P6d3：带换父的先后）；手写的测试 bundle 没有时按 `layers` 的 `parent` 现推（`install` 的 `appendChild`）
    if (bundle.children) for (const [parent, list] of bundle.children) state.children.set(parent, [...list]);
    // 相机基准（P5e）：正交（含手写的 bundle 没有 `perspective` 标记）= 重置值，`init` 之后一律重置；透视 = JSON 解析值，
    // 只有 `scene.json` 里是字符串的项覆盖 `init` 写的值（`given`，缺省当全给了；没有相机时都不覆盖）
    const camera = bundle.general.camera;
    if (bundle.general.perspective) {
      const pose: CameraPose = camera
        ? { eye: [...camera.eye], center: [...camera.center], up: [...camera.up], zoom: 1 }
        : constructedCameraBase();
      const given = camera ? (camera.given ?? { eye: true, center: true, up: true }) : null;
      state.cameraLoaded = {
        pose,
        overridden: (["eye", "center", "up"] as const).filter((field) => given?.[field]),
      };
    } else
      state.cameraLoaded = {
        pose: copyCameraPose({ ...ORTHOGRAPHIC_CAMERA_BASE, zoom: 1 }),
        overridden: ["eye", "center", "up"],
      };
    state.cameraBase = copyCameraPose(state.cameraLoaded.pose);
    // 手写的测试 bundle 可能没有声音表 / 灯表
    const soundOf = new Map((bundle.sounds ?? []).map((sound) => [sound.object, sound]));
    const lightOf = new Map((bundle.lightObjects ?? []).map((light) => [light.object, light]));
    for (const layer of bundle.layers)
      state.install(
        { layer, sound: soundOf.get(layer.object), light: lightOf.get(layer.object) },
        bundle.children === undefined,
      );
    // 没有图层的声音 / 灯（手写的测试 bundle）：只写它们自己的表
    const layered = new Set(bundle.layers.map((layer) => layer.object));
    for (const sound of bundle.sounds ?? [])
      if (!layered.has(sound.object)) state.sounds.set(sound.object, { volume: sound.volume });
    for (const light of bundle.lightObjects ?? [])
      if (!layered.has(light.object)) state.lights.set(light.object, structuredClone(light.values));
    return state;
  }

  /**
   * 一个对象的全部按对象的表（`fromBundle` 的循环体，L3a 抽出）：图层状态、材质常量（基础 pass、粒子含子系统与多 renderer、网格与阴影变体、effect
   * 绘制 pass、texchan、passthrough、组上屏、文本的四个 pass 与背景键）、effect 开关、粒子 `instanceoverride`（`rate` 钳 0.01）、对齐尺寸、声音、灯、
   * 相机、puppet 动画层字段、文本字段与冻结。占的键记进 `owned`。不动 `order` 与子表。
   */
  private installTables(slice: ObjectStateSlice): void {
    const { layer } = slice;
    const object = layer.object;
    const owned: OwnedKeys = { constants: [], effects: [], shadow: [] };
    this.owned.set(object, owned);
    const putConstant = (key: TargetKey, uniforms: Record<string, number[]>) => {
      this.constants.set(key, { ...uniforms });
      owned.constants.push(key);
    };
    this.layers.set(object, layerStateOf(layer));
    // 加载时 `rate` 钳到 0.01 并写回（`FUN_14022af30` `0x14022b840`–`0x14022b86f`，rea-p4f-script.md 6.1）：脚本 `init` 读到的就是钳过的
    // 值，和建系统时（`ParticleSystem` 构造）的钳制一致
    if (layer.particle) {
      const values = instanceValues(layer.particle.instance);
      this.particleInstances.set(object, { ...values, rate: Math.max(INSTANCE_RATE_MIN, values.rate) });
    }
    for (const pass of layer.passes) putConstant(pass.key, pass.uniforms);
    // 粒子材质的常量（P4a 步骤 4）：粒子 draw 的 uniform 同样从这里取，绑定也按 pass 键就地写；含系统树里的子系统（P4e 步骤 1）。
    // 第 2 条起的 renderer 的变体（P4f 步骤 4）各有自己的键，属性绑定两份都登记，这里各留一份
    const addParticle = (particle: SceneParticle) => {
      for (const pass of particle.passes) putConstant(pass.key, pass.uniforms);
      for (const draw of particleDraws(particle).slice(1))
        for (const pass of draw.passes) putConstant(pass.key, pass.uniforms);
      for (const child of particle.children ?? []) addParticle(child.system);
    };
    if (layer.particle) addParticle(layer.particle);
    // 模型网格材质的常量（P5c 步骤 2）：网格 draw 的 uniform 同样从这里取（retro 的 `g_Tint`），属性绑定按 pass 键就地写
    for (const mesh of layer.model?.meshes ?? []) {
      for (const pass of mesh.passes) putConstant(pass.key, pass.uniforms);
      // 阴影投射变体（P13d）：常量照 WPE 从基础程序按名字拷（编译期已拷好初值），基础 pass 的常量写入同时写它（`shadowPasses`）
      if (mesh.shadow && mesh.passes[0]) {
        putConstant(mesh.shadow.key, mesh.shadow.uniforms);
        this.shadowPasses.set(mesh.passes[0].key, mesh.shadow.key);
        owned.shadow.push(mesh.passes[0].key);
      }
    }
    for (const effect of layer.effects) {
      const key = effectKey(object, effect.source);
      this.effects.set(key, { enabled: effect.enabled, unsupported: effect.unsupported.length > 0 });
      owned.effects.push(key);
      for (const step of effect.steps) if (step.kind === "draw") putConstant(step.pass.key, step.pass.uniforms);
    }
    // puppet 纹理通道网格的材质常量（P12b2-2）：该 draw 的 uniform 同样从这里取
    if (layer.puppet?.textureChannels?.pass)
      putConstant(layer.puppet.textureChannels.pass.key, layer.puppet.textureChannels.pass.uniforms);
    if (layer.passthrough) putConstant(layer.passthrough.key, layer.passthrough.uniforms);
    // 组的上屏（P5b 步骤 4）：同 passthrough，g_Color4 由材质值置 1
    if (layer.groupUpload) putConstant(layer.groupUpload.key, layer.groupUpload.uniforms);
    // 文本的四个宿主 pass（P6b 1d）。背景常量总要有一份：没有背景 pass（合成路径清屏）时清屏色同样从它读，`backgroundcolor` 的
    // 就地写落在这里
    const text = layer.text;
    if (text) {
      for (const pass of [text.glyphPass, text.colorPass, text.backgroundPass, text.clearAlphaPass])
        if (pass) putConstant(pass.key, pass.uniforms);
      if (!this.constants.has(text.background.key))
        putConstant(text.background.key, { g_Color: [...text.background.color] });
    }
    if (layer.alignment !== undefined) this.alignmentSizes.set(object, [...layer.size]);
    if (slice.sound) this.sounds.set(object, { volume: slice.sound.volume });
    if (slice.light) this.lights.set(object, structuredClone(slice.light.values));
    // 相机对象（P5d 步骤 3）：拷一份，运行中改它不动 bundle
    if (layer.camera) this.cameras.set(object, { fov: layer.camera.fov, zoom: layer.camera.zoom });
    // puppet 的动画层字段（P12a 步骤 3 点 3）：拷一份，运行中改它不动 bundle；模型对象的骨骼（P12b2-1）同样
    (layer.puppet ?? layer.model?.skeleton)?.layers.forEach((def) =>
      this.animationLayers.set(animationLayerKey(object, def.entry), {
        rate: def.rate,
        blend: def.blend,
        visible: def.visible,
      }),
    );
    // 文本层的 effect 开关会改 `padding`、文字框与合成 RT（rea-p6b-layout 3.5），1d 没有就地重排：切换一律整场重编译（同冻结的图层）
    if (layer.text) {
      this.textObjects.add(object);
      this.textFields.set(object, copyTextFields(layer.text.fields));
      this.freezeLayer(object);
    }
  }

  /** `installTables` 加上对象表尾与（`appendChild`）父的子表尾；不动 `structureVersion`。 */
  private install(slice: ObjectStateSlice, appendChild: boolean): void {
    this.installTables(slice);
    const { layer } = slice;
    this.order.push(layer.object);
    if (appendChild && layer.parent !== null) {
      const list = this.children.get(layer.parent);
      if (list) list.push(layer.object);
      else this.children.set(layer.parent, [layer.object]);
    }
  }

  /**
   * 加一个对象（L3a，运行中增删）：写它的全部按对象的表（同 `fromBundle` 的循环体）、追加到 `order` 尾与父的子表尾，`structureVersion` 加一。
   * 对象已在时抛错。图层状态的 `parent` 取切片图层的 `parent`（父不在状态里时子表照挂，同 `fromBundle` 的手写 bundle 路径）。
   */
  addObject(slice: ObjectStateSlice): void {
    if (this.layers.has(slice.layer.object)) throw new Error(`对象 ${slice.layer.object} 已在状态里`);
    this.install(slice, true);
    this.structureVersion++;
  }

  /** 清掉一个对象的全部按对象的表与它留在各脏集合里的项；不动 `order` 与子表（`dropObject` 另管）。 */
  private clearTables(object: number): void {
    const owned = this.owned.get(object);
    if (owned) {
      for (const key of owned.constants) {
        this.constants.delete(key);
        this.passStates.delete(key);
        this.dirtyPasses.delete(key);
      }
      for (const key of owned.effects) this.effects.delete(key);
      for (const key of owned.shadow) this.shadowPasses.delete(key);
      this.owned.delete(object);
    }
    this.layers.delete(object);
    this.textureAnimations.delete(object);
    this.particleInstances.delete(object);
    this.sounds.delete(object);
    this.lights.delete(object);
    this.cameras.delete(object);
    const prefix = `${object}:`;
    for (const key of [...this.animationLayers.keys()]) if (key.startsWith(prefix)) this.animationLayers.delete(key);
    this.texts.delete(object);
    this.textFields.delete(object);
    this.textObjects.delete(object);
    this.alignmentSizes.delete(object);
    this.frozenLayers.delete(object);
    this.pendingDestroy.delete(object);
    this.dirtyLayers.delete(object);
    this.transformWrites.delete(object);
    this.dirtyStructures.delete(object);
    this.dirtyParticles.delete(object);
    this.dirtyTexts.delete(object);
    this.rateParticles.delete(object);
    this.dirtyPassStates.delete(object);
  }

  /**
   * 把图层 effect 的「带不支持项」同步进 effect 开关表（L3a）：登记表的 `restructure` 重算之后调（P5f 起组里读快照不再给 effect 记标记，通常没有变化），
   * `needsRecompile` 读的就是这一份。只改 `unsupported`，不动 `enabled`（运行中写的开关）；状态里没有这一项时什么都不做。
   */
  syncEffectSupport(layer: SceneLayer): void {
    for (const effect of layer.effects) {
      const state = this.effects.get(effectKey(layer.object, effect.source));
      if (state) state.unsupported = effect.unsupported.length > 0;
    }
  }

  /**
   * 清掉一个对象的全部按对象的表（L3a；`flushDestroy` 之后调：它不清常量、effect 开关、粒子实例等）。结构归 `flushDestroy` 管：对象还在
   * `order` 里时不动 `order` 与子表；不在 `order` 里（已被 `flushDestroy` 摘掉）时顺手确保它不在任何子表里、没有自己的子表。
   */
  dropObject(object: number): void {
    this.clearTables(object);
    if (this.order.includes(object)) return;
    for (const [parent, list] of [...this.children]) {
      const at = list.indexOf(object);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.children.delete(parent);
    }
    this.children.delete(object);
  }

  /**
   * 换成新编的同一对象（L3a，L5 / L6 用）：`order` 的位置、`parent`（运行中的父）、子表、冻结与待删标记不动，其余按对象的表按新切片重建
   * （运行中的写入——常量覆盖、脚本写的字段、动画层字段、排版结果——都回到新切片的初值，由宿主重放这个对象的脚本写入，L3b）。`structureVersion` 加一，
   * 渲染侧据此重建派生表。对象不在状态里时抛错。
   */
  replaceObject(slice: ObjectStateSlice): void {
    const object = slice.layer.object;
    const old = this.layers.get(object);
    if (!old) throw new Error(`对象 ${object} 不在状态里`);
    const parent = old.parent;
    const frozen = this.frozenLayers.has(object);
    const pending = this.pendingDestroy.has(object);
    // 纹理动画的私有状态跨单对象重编译保留（P6e 点 3）：脚本手里的外壳还认它
    const textureAnimation = this.textureAnimations.get(object);
    this.clearTables(object);
    this.installTables(slice);
    if (textureAnimation) this.textureAnimations.set(object, textureAnimation);
    this.layers.get(object)!.parent = parent;
    if (frozen) this.frozenLayers.add(object);
    if (pending) this.pendingDestroy.add(object);
    this.structureVersion++;
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
   * 把一个用户纹理来源标进 `dirtyUserTextures`（P11b 步骤 2）：宿主的来源表解码完成（或回到缺省）时调，下一次 `sync` 换上。
   */
  touchUserTexture(name: string): void {
    this.dirtyUserTextures.add(name);
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

  /**
   * 对象表里排序（WPE 宿主 `+0x38`，P6d3）：先摘掉再插到 `index`（u32 比较：越界与负数到末尾）；`index` 由调用方给整数（API 侧 ToInt32）。
   * 不在表里返回 false。不改子表（组内顺序跟子表走）。
   */
  sortLayer(object: number, index: number): boolean {
    const at = this.order.indexOf(object);
    if (at < 0) return false;
    this.order.splice(at, 1);
    const count = this.order.length;
    const target = index >>> 0 >= count ? count : index >>> 0;
    this.order.splice(target, 0, object);
    this.structureVersion++;
    return true;
  }

  /**
   * 新建对象（P6d3b，`createLayer` 的待编对象）：写 `layers`、追加到 `order` 尾、父不为空时追加到父的子表尾（WPE 的 `createLayer` 不跑加载末的
   * 补挂，父的存在性由调用方查）。`size` 是图像层的尺寸（缺省未知 0×0）。键沿用 `objects` 下标空间，所以调用方给的下标必须是新的。
   */
  addLayer(object: number, layer: LayerState, size: readonly number[] = [0, 0]): void {
    this.layers.set(object, layer);
    // 图像层脚本写 `alignment` 要按尺寸重算偏移（`writeAlignment`）；编译前尺寸未知给 0×0（偏移为 0，编完由重放补上）
    if (layer.alignment !== undefined) this.alignmentSizes.set(object, [...size]);
    this.order.push(object);
    if (layer.parent !== null) {
      const list = this.children.get(layer.parent);
      if (list) list.push(object);
      else this.children.set(layer.parent, [object]);
    }
    this.structureVersion++;
  }

  /**
   * 标记待删（WPE 宿主 `+0x28`）：在表里就记进待删集合（已在也照样）返回 true，否则 false。待删不影响绘制，所以不动 `structureVersion`；
   * 生效在脚本阶段之后（`flushDestroy`）。
   */
  markDestroy(object: number): boolean {
    if (!this.order.includes(object)) return false;
    this.pendingDestroy.add(object);
    return true;
  }

  /**
   * 待删生效（脚本阶段之后）：按标记先后逐个从 `order`、`layers`、父的子表摘掉；它的每个子对象变根（`parent = null`，本地字段不动，世界变换
   * 随之跳变），这些子对象及其子树标成变换脏（世界矩阵与影子缓存失效，同写 `origin`）；删掉自己的子表。返回实际删掉的对象（按顺序），
   * 交给运行时与渲染侧清理。
   */
  flushDestroy(): number[] {
    const removed: number[] = [];
    for (const object of this.pendingDestroy) {
      const at = this.order.indexOf(object);
      if (at < 0) continue;
      this.order.splice(at, 1);
      const parent = this.layers.get(object)?.parent ?? null;
      this.layers.delete(object);
      if (parent !== null) this.detachChild(parent, object);
      for (const child of this.children.get(object) ?? []) {
        const state = this.layers.get(child);
        if (state) state.parent = null;
        this.markTransformDirty(child);
      }
      this.children.delete(object);
      removed.push(object);
    }
    this.pendingDestroy.clear();
    if (removed.length > 0) this.structureVersion++;
    return removed;
  }

  /**
   * 换父（`adjust` 的数学在 API 一侧，这里只改结构）：从旧父的子表摘掉，改 `parent`，非空时追加在新父子表的末尾（步骤 0 实测：挂上的追加在尾），
   * 把这个对象的子树标成变换脏。不做任何检查（环、组深度归 API）。
   */
  setParent(object: number, parent: number | null): void {
    const layer = this.layers.get(object);
    if (!layer) return;
    if (layer.parent !== null) this.detachChild(layer.parent, object);
    layer.parent = parent;
    if (parent !== null) {
      const list = this.children.get(parent);
      if (list) list.push(object);
      else this.children.set(parent, [object]);
    }
    this.markTransformDirty(object);
    this.structureVersion++;
  }

  /** 直接子（子表顺序）；没有就空数组。 */
  childrenOf(object: number): readonly number[] {
    return this.children.get(object) ?? [];
  }

  /** 运行时建层（P12e）：写进三方共写字段的起始值（API 规整后的 rate / blend / visible）。 */
  addAnimationLayer(object: number, id: number, fields: PuppetLayerFields): void {
    this.animationLayers.set(animationLayerKey(object, id), {
      rate: fields.rate,
      blend: fields.blend,
      visible: fields.visible,
    });
  }

  /** 层释放（P12e）：删掉这一项；之后用户属性、脚本写入、重放对它都是空操作。 */
  removeAnimationLayer(object: number, id: number): void {
    this.animationLayers.delete(animationLayerKey(object, id));
  }

  /** 槽 0 换成别的纹理（用户纹理换图，WPE `FUN_140209360`）：删条目，脚本手里的外壳随之作废。 */
  dropTextureAnimation(object: number): void {
    this.textureAnimations.delete(object);
  }

  /**
   * 整场重编译后接过旧状态里的纹理动画条目（P6e 点 3）：同一个条目对象（外壳的身份不变），只收新状态里还有的图层。在新状态首帧前调。
   */
  adoptTextureAnimations(previous: SceneState): void {
    for (const [object, entry] of previous.textureAnimations)
      if (this.layers.has(object) && !this.textureAnimations.has(object)) this.textureAnimations.set(object, entry);
  }

  /**
   * 重编译 / 换场景后按 puppet 运行时的层表对齐（P12e）：在 `puppets.carryOver` 之后、重放脚本写入之前调。运行时有、本状态没有的项（运行时建的层）
   * 从 `previous` 拷，`previous` 也没有就取层定义；本状态有、运行时没有的项（删过的编译期层）删掉（给了 objects 参数，只删这些对象的：静态 puppet 没有运行时、状态里的项要留着）。
   */
  syncAnimationLayers(
    layers: Iterable<{ object: number; id: number; def: PuppetLayerFields }>,
    previous: SceneState | null,
    objects?: ReadonlySet<number>,
  ): void {
    const live = new Set<string>();
    for (const { object, id, def } of layers) {
      const key = animationLayerKey(object, id);
      live.add(key);
      if (this.animationLayers.has(key)) continue;
      const old = previous?.animationLayers.get(key) ?? def;
      this.animationLayers.set(key, { rate: old.rate, blend: old.blend, visible: old.visible });
    }
    for (const key of [...this.animationLayers.keys()])
      if (!live.has(key) && (!objects || objects.has(Number(key.slice(0, key.indexOf(":"))))))
        this.animationLayers.delete(key);
  }

  /**
   * 重编译后新状态接过旧状态的结构（P6d3）：`order` 滤掉新状态里没有的、新状态里有而旧表没有的按新状态原顺序追加在尾；待删集合滤掉不存在的。
   * 父与子表：双方都有的对象照搬旧状态的（首次加载时 `init` 里的 `setParent` 落在宿主自建的脚本状态上，bundle 是 `init` 之前编的、不含它；
   * 重编译后 bundle 已带结构，照搬是幂等的）。旧父不在这个状态里时当根；改了父的对象把子树标成变换脏。只在新状态首帧前调。
   */
  adoptStructure(previous: SceneState): void {
    const shared = new Set<number>();
    for (const object of this.layers.keys()) if (previous.layers.has(object)) shared.add(object);
    const changed: number[] = [];
    for (const object of shared) {
      const own = this.layers.get(object)!;
      const old = previous.layers.get(object)!.parent;
      const parent = old !== null && this.layers.has(old) ? old : null;
      if (own.parent !== parent) {
        own.parent = parent;
        changed.push(object);
      }
    }
    const lists = new Map<number, number[]>();
    for (const [parent, list] of previous.children) {
      const kept = list.filter((child) => shared.has(child) && this.layers.get(child)!.parent === parent);
      if (kept.length > 0 && this.layers.has(parent)) lists.set(parent, kept);
    }
    for (const [object, layer] of this.layers) {
      if (shared.has(object) || layer.parent === null) continue;
      const list = lists.get(layer.parent);
      if (list) list.push(object);
      else lists.set(layer.parent, [object]);
    }
    this.children.clear();
    for (const [parent, list] of lists) this.children.set(parent, list);
    for (const object of changed) this.markTransformDirty(object);
    const kept = previous.order.filter((object) => this.layers.has(object));
    const seen = new Set(kept);
    const added = this.order.filter((object) => !seen.has(object));
    this.order.length = 0;
    this.order.push(...kept, ...added);
    this.pendingDestroy.clear();
    for (const object of previous.pendingDestroy) if (this.layers.has(object)) this.pendingDestroy.add(object);
    this.structureVersion++;
  }

  private detachChild(parent: number, child: number): void {
    const list = this.children.get(parent);
    if (!list) return;
    const at = list.indexOf(child);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.children.delete(parent);
  }

  /** 与写 `origin` 同一机制：对象本身记直接写过变换（影子缓存清戳），整棵子树标脏（世界矩阵重算）。 */
  private markTransformDirty(object: number): void {
    this.transformWrites.add(object);
    for (const item of this.subtree(object)) this.dirtyLayers.add(item);
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

  /**
   * 脚本 `init` 之前（P5e）：相机基准换成构造缺省值（`init` 里 `getCameraTransforms` 读到的、`setCameraTransforms` 写进的就是它）。
   * 只在首次加载 / 清空脚本存储后重建脚本环境时调（重编译不重跑 `init`）。
   */
  beginScriptInit(): void {
    this.cameraBase = constructedCameraBase();
  }

  /**
   * 全部脚本 `init` 跑完之后（P5e，WPE 先跑 `init`、后读 `scene.json` 的 `camera`）：正交场景 eye / center / up 一律重置，透视场景只有
   * `scene.json` 里是字符串的项覆盖，不是字符串的保留 `init` 写的值；`zoom` 不受影响（`init` 里写的留下）。返回被覆盖的字段，宿主据此把脚本对它们的
   * 写入从重放表里去掉（`ScriptRuntime.forgetWrite`，否则重编译重放时会复活）。
   */
  finishScriptInit(): CameraBaseField[] {
    const { pose, overridden } = this.cameraLoaded;
    const base = this.cameraBase;
    for (const field of overridden) if (field !== "zoom") base[field] = [...pose[field]];
    return [...overridden];
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
    // bool setter 不收数字、字符串属性（同 `write`）
    const enabled = conditioned(binding, raw);
    if (!effect || typeof enabled !== "boolean" || enabled === effect.enabled) return false;
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
      // 同编译期（`boolFieldValue`）：WPE 的 bool setter 只收布尔，数字、字符串属性写不进、开关不变（phase-3a「补测」`p3am-num` F1–F3）
      const enabled = conditioned(binding, raw);
      if (typeof enabled !== "boolean" || enabled === effect.enabled) return "applied";
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
      // 环境光与雾（P13f）的字段进 uniform：刷进声明了它们的 draw
      if (target.key === "ambientcolor" || target.key === "skylightcolor" || isFogUniformField(target.key))
        this.lightsDirty = true;
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
    if (target.kind === "light") {
      const light = this.lights.get(target.object);
      // 取值规则与编译期相同（`lightFieldValue`），条件先换成布尔；不合法的值不改字段
      const value = lightFieldValue(target.field, conditioned(binding, raw));
      if (light && value !== undefined) (light as Record<LightField, number | number[]>)[target.field] = value;
      return "applied";
    }
    if (target.kind === "sound") {
      const sound = this.sounds.get(target.object);
      // 取值规则与编译期相同（`soundVolume`），条件先换成布尔；不合法的值不改字段（WPE 的 float 解析器不收时不写）
      const value = soundVolume(conditioned(binding, raw));
      if (sound && value !== undefined) sound.volume = value;
      return "applied";
    }
    if (target.kind === "camera") {
      const camera = this.cameras.get(target.object);
      // 取值规则与编译期相同（`cameraValue`），条件先换成布尔；不合法的值不改字段（同 general 的 float）
      const value = cameraValue(conditioned(binding, raw));
      if (camera && value !== undefined) camera[target.field] = value;
      return "applied";
    }
    // 相机基准（P5e，只由脚本 API 产生）：值是 float32 转出来的分量（API 已按「数字取 float32、不是数字记 0」规整），NaN / Infinity 照存
    if (target.kind === "camera-base") {
      const parts = typeof raw === "string" ? raw.split(" ").map(Number) : [Number(raw)];
      if (target.field === "zoom") this.cameraBase.zoom = f32(parts[0]);
      else this.cameraBase[target.field] = [f32(parts[0] ?? 0), f32(parts[1] ?? 0), f32(parts[2] ?? 0)];
      return "applied";
    }
    if (target.kind === "animation-layer") {
      const fields = this.animationLayers.get(animationLayerKey(target.object, target.layer));
      // 取值规则与编译期相同（`animationLayerValue`），条件先换成布尔；不合法的值不改字段
      const value = animationLayerValue(target.field, conditioned(binding, raw));
      if (fields && value !== undefined) {
        if (target.field === "visible") fields.visible = value as boolean;
        else fields[target.field] = value as number;
      }
      return "applied";
    }
    // 脚本转向（P6d1a）：`rotateObjectSpace` 带乘出来的 3×3，`lookAt` / `lookAtYaw` 带 null（按角度重建）；角度原样存进状态（NaN 也存），
    // 记变换写入、子树标脏，同 `angles`。
    // 值（`raw`）不看：目标自己带着两份数据
    if (target.kind === "rotation") {
      const layer = this.layers.get(target.object);
      if (layer) {
        layer.rotation = target.rotation ? [...target.rotation] : null;
        layer.angles = [...target.angles];
        this.transformWrites.add(target.object);
        for (const object of this.subtree(target.object)) this.dirtyLayers.add(object);
      }
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
      // 光标命中的开关（P6c）：只改状态，不标脏（不影响绘制）；脚本只收布尔（`script/api.ts`）
      // TODO:[WPE_SCENE] 没实测：`solid` 绑数字、字符串属性时 WPE 收不收。`visible` 的 bool setter 不收、留 value（phase-3a「补测」
      // `p3am-num`），`solid` 是不是同一个 setter 没有读码依据，这里照旧按「不是 false 就算真」
      if (layer && field === "solid") {
        layer.solid = bindingValue(raw, binding.condition, field) !== false;
        return "applied";
      }
      // 透视覆盖的开关（P5h）：只改状态；WPE 每次画都现读（`p5h-a` 实测当帧生效），我们的 uniform 只在图层标脏时重写，所以标这一个图层脏
      // （不带子孙：它不继承）；脚本只收布尔（`script/api.ts`）
      if (layer && field === "perspective") {
        layer.perspective = bindingValue(raw, binding.condition, field) === true;
        this.dirtyLayers.add(target.object);
        return "applied";
      }
      if (layer && field !== "alignment" && field !== "solid" && field !== "perspective") {
        // 向量字段（origin / scale / color / parallaxDepth）照 WPE 的向量 setter，同编译期（`layerVectorValue`，P6b 1e-3 复核）：
        // 数字铺满、字符串少写的分量为 0；写不进（布尔）时 WPE 不改字段，这里也不写、不标脏
        if (isLayerVectorField(field)) {
          const vector = layerVectorValue(field, conditioned(binding, raw));
          if (!vector) return "applied";
          writeLayer(layer, field, vector);
        } else {
          // 标量字段（alpha / brightness）照 WPE 的 float setter 不收布尔（条件换成的、布尔属性本身）：不写、不标脏，同编译期（`bundle.ts`
          // 的 `scalar`，P3a 补测 NC1–NC5、`p3am-bright`）
          if ((field === "alpha" || field === "brightness") && typeof conditioned(binding, raw) === "boolean")
            return "applied";
          // `visible` 照 WPE 的 bool setter 只收布尔：数字、字符串属性不写、不标脏，同编译期（`boolFieldValue`，phase-3a「补测」
          // `p3am-empty` W5、`p3am-num` U1–U3）
          if (field === "visible" && typeof conditioned(binding, raw) !== "boolean") return "applied";
          writeLayer(layer, field, bindingValue(raw, binding.condition, field));
        }
        // 角度写入一律按新角度重建 3×3（WPE 的角度 setter `FUN_1401dd630`），乘出来的那份丢掉（P6d1a）
        if (field === "angles") layer.rotation = null;
        // 变换写入（属性、关键帧、脚本同一条路；向量写不进时上面已返回）：影子缓存清戳（WPE 描述符回调 `0x1401e0520`，B1）
        if (field === "origin" || field === "angles" || field === "scale") this.transformWrites.add(target.object);
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
      if (changed) {
        this.dirtyPasses.add(target.pass);
        // 投射变体（P13d）：同名的常量跟着改
        const shadowKey = this.shadowPasses.get(target.pass);
        const shadow = shadowKey ? this.constants.get(shadowKey) : undefined;
        if (shadowKey && shadow) {
          for (const member of constantMembers(target))
            if (member.name in shadow) shadow[member.name] = constants[member.name];
          this.dirtyPasses.add(shadowKey);
        }
      }
      return "applied";
    }
    if (target.kind === "text") {
      // 属性侧取值规则与编译期相同（`textFieldFromJson`：`text` 只收字符串），条件先换成布尔
      this.writeText(target.object, target.field, textFieldFromJson(target.field, conditioned(binding, raw)));
      return "applied";
    }
    // 用户纹理（P11b 步骤 2）：值只认字符串，别的类型当空串；记下、标脏（RT 参考的槽从这里起才生效，M8），同步交给宿主的来源表解码，
    // 解码完成时宿主再 `touchUserTexture`。条件无意义，不看
    if (target.kind === "user-texture") {
      const value = typeof raw === "string" ? raw : "";
      this.userTextures.set(target.name, value);
      this.userWritten.add(target.name);
      this.dirtyUserTextures.add(target.name);
      this.onUserTexture?.(target.name, value);
      return "applied";
    }
    // 材质状态字段（P6d1b）：值按字段的表规整（`null` / `undefined` 不写，其余先 `ToString`，查不到取表的第一项），条件无意义、不看；
    // 写入当场把图层记进「要重建」，同值也记（WPE 每次绑定现读，没有变没变的判断）
    if (target.kind === "pass-state") {
      this.writePassState(target.pass, target.field, raw);
      return "applied";
    }
    this.bloom = writeBloomParam(this.bloom, target.field, raw, binding.condition);
    this.bloomDirty = true;
    return "applied";
  }

  /**
   * 写一个 pass 的状态字段（P6d1b）：`pass` 不在 bundle 里（不是 `objects/<i>/…` 的 pass、没登记常量）或值不合法（`null` / `undefined`）时什么都不做。
   * 返回是否写进了状态。
   */
  writePassState(pass: TargetKey, field: PassStateField, raw: unknown): boolean {
    const value = normalizePassState(field, raw);
    if (value === undefined || !this.constants.has(pass)) return false;
    const match = /^objects\/(\d+)\//.exec(pass);
    if (!match) return false;
    const fields = this.passStates.get(pass);
    if (fields) fields[field] = value;
    else this.passStates.set(pass, { [field]: value });
    this.dirtyPassStates.add(Number(match[1]));
    return true;
  }

  /** 是否有未取走的变换写入（只读，B1：渲染阶段预置据此作废）。 */
  hasTransformWrites(): boolean {
    return this.transformWrites.size > 0;
  }

  /** 取走直接写过变换的对象（取走即清空，B1）。 */
  takeTransformWrites(): Set<number> {
    const writes = this.transformWrites;
    this.transformWrites = new Set();
    return writes;
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
      userTextures: this.dirtyUserTextures,
      passStates: this.dirtyPassStates,
    };
    this.dirtyLayers = new Set();
    this.dirtyPasses = new Set();
    this.bloomDirty = false;
    this.dirtyStructures = new Set();
    this.lightsDirty = false;
    this.dirtyParticles = new Set();
    this.dirtyTexts = new Set();
    this.rateParticles = new Set();
    this.dirtyUserTextures = new Set();
    this.dirtyPassStates = new Set();
    return dirty;
  }
}
