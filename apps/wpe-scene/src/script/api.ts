import {
  GENERAL_FIELDS,
  LIGHT_FIELDS,
  type LightField,
  scriptPropertyEntries,
  TEXT_RUNTIME_FIELDS,
  type BindingTarget,
  type GeneralKey,
  type TextRuntimeField,
  type UserProperty,
  type ValueType,
} from "../compile/bindings";
import { AnimationClock } from "../animation/clock";
import type { AnimationControl } from "../animation/player";
import type { SceneAnimation } from "../animation/types";
import type { SceneSpectrum } from "../audio/spectrum";
import { alignmentIndex, alignmentName } from "../compile/alignment";
import type { SceneBundle, SceneEffect, SceneLayer, ScenePass } from "../compile/bundle";
import { constantTargetFields, materialSlots, type MaterialMember } from "../compile/materialValues";
import { isPassStateField, type PassStateField } from "../compile/passState";
import { FLT_MAX, INSTANCE_CONTROL_POINT_KEYS, INSTANCE_FIELDS, instanceControlPoint } from "../compile/particles";
import { BLOOM_FIELDS } from "../compile/postprocess";
import type { SceneStructure } from "../compile/protocol";
import { normalizeConfig } from "../compile/config";
import { layerShellValues } from "../compile/layerShell";
import type { SceneObject, SceneScalar } from "../compile/model";
import { collectObjectScriptsSync, type SceneScript } from "../compile/scripts";
import { TEXT_ANCHORS } from "../compile/texts";
import type { PuppetAnimation } from "../compile/puppet";
import {
  animationLayerKey,
  puppetEntries,
  type AnimationLayerItem,
  type PuppetLayerControl,
  type PuppetRig,
} from "../puppet/player";
import type { CursorInputSnapshot } from "../render/cursor";
import { anglesRotation, drawMatrixOf } from "../render/layout";
import { extractEulerZYX, lookAtAngles, lookAtYawAngles, rotateObjectSpace } from "../render/rotation";
import { adjustReparent } from "../render/adjust";
import type { SceneState } from "../render/state";
import { scriptToString } from "../text/fields";
import { layerVideoSource } from "../video/sceneVideos";
import { copySpectrumToBuffers, type AudioBuffers } from "./audio";
import { animationLayerItem, type RealmJson } from "./animationLayerConfig";
import { createdLayerKind, createLayerConfig, type CreatedLayerKind, type CreateConfigContext } from "./createConfig";
import { degreesFromScript, radiansToScript, scriptNumber, scriptNumbers } from "./f32";
import type { ScriptRealm, ScriptRuntime, ScriptValue } from "./runtime";
import { materialObjectKeys } from "./materialKeyOrder";
import { createMemoryStorage, LOCATION_GLOBAL, LOCATION_SCREEN, SceneScriptStorage } from "./storage";

type ApiObject = Record<string, unknown>;

/** 单位矩阵（列主序，`getBoneTransform` 失败的返回值与 `setBoneTransform` 缺省的底）。 */
const IDENTITY_4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 向量参数的 f32 分量（P6d1a）：对象取 `x / y / z`（`Number()` 后非有限数当 0），否则用缺省。 */
function vec3Arg(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (value === null || typeof value !== "object") return fallback;
  const part = (key: string): number => {
    const n = Number((value as ApiObject)[key]);
    return Number.isFinite(n) ? Math.fround(n) : 0;
  };
  return [part("x"), part("y"), part("z")];
}
type ApiTarget = BindingTarget | { kind: "unsupported"; path: string };

/** 材质对象上登记的一个常量键（P6d1a）：形状同 `constantTargetFields`，`rad2deg` 的 float 键脚本里用度。 */
interface MaterialConstant {
  shape: { uniforms: string[]; type: ValueType; members?: MaterialMember[] };
  rad2deg: boolean;
}

/** 模块求值期间调用 scoped 方法 / 访问 scoped 属性时抛错（`ScriptApi` 与 WPE `localStorage` 共用）。 */
export function requireCallbackContext(name: string, evaluating: boolean): void {
  if (evaluating) throw new Error(`${name} 不能在模块求值期间访问`);
}

/**
 * 造挂在场景子 frame 全局上的 WPE `localStorage`：成员只有 `get` / `set` / `delete` / `clear` 与两个位置常量，
 * 没有 `remove`（报告 A；样本调 `remove` 照样报 `TypeError`）。四个方法在模块求值期间调用抛错（报告 D）。
 * `get` 用子 frame 的 `JSON.parse` 造值，脚本里 `instanceof Array` 才为真。
 */
export function createWpeLocalStorage(input: {
  global: Record<string, unknown>;
  /** 宿主的 `Storage`；null = 只存在内存里（宿主没有图片 id，或读不到浏览器存储）。 */
  backend: Storage | null;
  sceneKey: string;
  isEvaluating: () => boolean;
  debug?: (message: string) => void;
}): object {
  const object = input.global.Object as ObjectConstructor;
  const storage = new SceneScriptStorage(input.backend ?? createMemoryStorage(), input.sceneKey, {
    parse: (text) => (input.global.JSON as JSON).parse(text),
    debug: input.debug,
  });
  const api = object.create(null) as Record<string, unknown>;
  const define = (name: string, value: unknown) =>
    object.defineProperty(api, name, { value, enumerable: true, writable: false, configurable: false });
  const method = (name: string, run: (...args: unknown[]) => unknown) =>
    define(name, (...args: unknown[]) => {
      requireCallbackContext(`localStorage.${name}`, input.isEvaluating());
      return run(...args);
    });
  const locationOf = (value: unknown) => (typeof value === "number" ? value : LOCATION_SCREEN);
  method("get", (key, location) => storage.get(String(key), locationOf(location)));
  method("set", (key, value, location) => storage.set(String(key), value, locationOf(location)));
  method("delete", (key, location) => storage.delete(String(key), locationOf(location)));
  method("clear", (location) => storage.clear(locationOf(location)));
  define("LOCATION_GLOBAL", LOCATION_GLOBAL);
  define("LOCATION_SCREEN", LOCATION_SCREEN);
  return api;
}

/**
 * 一个对象的 puppet 动画层视图（P12c，宿主从 `ScenePuppets` 现取）：`getAnimationLayerCount` / `getAnimationLayer` 与 `IAnimationLayer` 接到它上面。
 * 不是 skinned puppet / 没有骨骼的对象不给（`puppetLayers` 返回 null 或 `count()` 为 0）。
 */
export interface PuppetLayersView {
  /** 层表的 id（顺序，P12e：下标只在 `getAnimationLayer(下标)` 里出现；层数就是它的长度）。 */
  ids(): readonly number[];
  /** 按当前名字找，最后一个匹配，空串不匹配；返回层 id，找不到 null。 */
  find(name: string): number | null;
  /** 控制口（按 id）；没有这个 id 为 null。 */
  control(id: number): PuppetLayerControl | null;
  /** 包装还有效（层没被释放）。 */
  alive(id: number): boolean;
  /**
   * 动画表（P12e，同一份 rig，`createAnimationLayer` 的参数规整按它找动画）与运行时建删层。可选：语料诊断、单测的最小视图不给时，
   * 三个方法返回 `null` / `false`。`destroy` 的选择器已由 API 规整（名字、层表下标、层 id）。
   */
  animations?(): readonly PuppetAnimation[];
  create?(item: AnimationLayerItem, single: boolean): number | null;
  destroy?(selector: { name: string } | { index: number } | { id: number }): boolean;
  /**
   * 骨骼脚本方法的落点（P12d-2，`ScenePuppets` 的同名方法；骨骼选择器已由 API 规整成 Int32 数或字符串）。可选：语料诊断、单测的最小视图不给时，
   * `getBoneTransform` 返回单位阵、其余空操作。
   */
  boneTransform?(bone: number | string): Float32Array | null;
  setBoneTransform?(bone: number | string, matrix: ArrayLike<number>): void;
  applyBonePhysicsImpulse?(bone: number | string, dir: ArrayLike<number>, ang: ArrayLike<number>): void;
  resetBonePhysicsSimulation?(bone: number | string): void;
}

export interface ScriptApiState {
  bundle(): SceneBundle;
  state(): SceneState;
  screenResolution(): readonly [number, number];
  frametime(): number;
  runtime(): number;
  timeOfDay(): number;
  /** 普通目标由宿主写入 SceneState；重编译目标由宿主合并请求。字符串只在文本目标上（P6b 1e）。 */
  write(target: ApiTarget, value: ScriptValue): boolean;
  read?(target: ApiTarget): ScriptValue | null;
  /** 脚本注册了音频缓冲：宿主据此订阅音频。语料与 `realmCheck` 不传，缓冲保持全零。 */
  audioRegistered?(): void;
  /**
   * 声音对象的排期器（P6a 步骤 2，宿主从 `SceneSounds` 取）：声音层的 `play` / `pause` / `stop` / `isPlaying` 接到它上面。
   * 不传或返回 null（没有播放器、场景已退回）时方法什么都不做，`isPlaying` 为假。
   */
  sound?(object: number): SoundScriptTarget | null;
  /**
   * 视频纹理的播放器（P9b，宿主按图层槽 0 视频的区间从 `SceneVideos` 现取）：`IVideoTexture` 的方法接到它上面。
   * 不传或返回 null（语料诊断、播放器已释放）时方法空操作，`duration` 退回 bundle 里的容器时长。
   */
  video?(object: number): VideoScriptTarget | null;
  /**
   * 粒子对象的根系统（P4f 步骤 3，宿主从渲染器的场景取，`GpuScene.particleScript`）：粒子层的 `play` / `pause` / `stop` / `isPlaying` /
   * `emitParticles` 接到它上面。不传或返回 null（没有场景）时方法什么都不做，`isPlaying` 为假。
   */
  particles?(object: number): ParticleScriptTarget | null;
  /**
   * 图层的绘制矩阵（P6d1a，`getTransformMatrix`）：宿主按渲染器当前状态与挂点钩子现算。不传或返回 null（单测的假 access、首次加载的
   * `init`）时退回按 `state().layers` 纯状态现算（没有挂点）。
   */
  transformMatrix?(object: number): Float32Array | null;
  /**
   * 挂点钩子（P6d3a，同 `worldMatrixOf` 的 `attach`：父 puppet 骨骼的 `Pose · Att`，没有挂点返回 null）：`setParent` 的 adjust 数学按它算
   * 世界矩阵与刚体链。不传时当没有挂点（单测、首次加载的 `init`）。
   */
  attachPose?(object: number): Float32Array | null;
  /**
   * 宿主维护的运行中结构（P6d3a）：`setParent` 用它找对象当前的挂点名（运行中换过父的取最后一条）。不传当空。
   */
  structure?(): SceneStructure;
  /**
   * `setParent` 已改完状态（含组深度检查失败后父被置空的情形）：宿主把它记进结构、按需请求重编译（`script/structure.ts`）。
   * `bone` 是挂点名（没有挂点是 null）。
   */
  reparented?(change: {
    object: number;
    oldParent: number | null;
    oldBone: string | null;
    parent: number | null;
    bone: string | null;
  }): void;
  /** 宿主的日志通道（成环拒绝等）。不传时落到 `console.warn`。 */
  warn?(message: string): void;
  /**
   * 关键帧动画的落点（P10b，宿主按脚本当前看到的 bundle 取播放器的那一条，`SceneAnimations.control`）：`IAnimation` 的成员接到它上面。
   * 不传或返回 null（语料诊断、播放器还没建）时方法空操作，只读成员取 bundle 里这一条的定义。
   */
  animation?(id: string): AnimationControl | null;
  /**
   * puppet 动画层（P12c，宿主按脚本当前看到的 bundle 取 `ScenePuppets`，首次加载的 `init` 取待用的那份）：每次现取，重编译换了运行时也接得上。
   * 不传或返回 null（语料诊断、`realmCheck`）时退回按 bundle 的层定义回答：计数、名字查找、只读三项照算，方法空操作，`isPlaying()` 为假，`getFrame()` 为 0。
   */
  puppetLayers?(object: number): PuppetLayersView | null;
  /**
   * 全局 `input` 读到的本帧光标（P6c，宿主存渲染器每个实时帧给的 `CursorInputSnapshot`）：每次读都现取，所以回调里读到的和 `update` 里同一帧的相同。
   * 不传（语料诊断、`realmCheck`）时读到全 0、左键松开。
   */
  cursorInput?(): CursorInputSnapshot;
  /**
   * 正在跑的回调名（P11d，`ScriptRuntime.activeCallback`）：`engine.openUserShortcut` 只许在 `cursorClick` / `cursorDown` / `cursorUp` 里调。
   * 不传（语料诊断、`realmCheck`）时当不在任何回调里，调用抛错。
   */
  activeCallback?(): string | null;
  /**
   * 脚本调 `engine.openUserShortcut(name)`（P11d，门禁里参数已核对为字符串）：宿主先取点击令牌，再查属性全集。返回码同 WPE 宿主：
   * 0 = 失败（属性不是已配好的快捷方式），1 = 成功（宿主已把属性名交给父页面），2 = 没有令牌（同一次点击已用过 / 没有点击）。
   * 不传时当 0（语料诊断没有宿主）。
   */
  openUserShortcut?(name: string): 0 | 1 | 2;
  /** 当前正在调用的脚本的 `__workshopId`（P6d3b，`ScriptRuntime.currentWorkshopId`）；没有是 null。不传当没有。 */
  workshopId?(): string | null;
  /**
   * `createLayer` 的落点（P6d3b）：宿主分配下标、建出待编对象（`createStructureObject`：状态、对象表尾、结构）、安排重编译，返回新下标；
   * 建不出来返回 null。`parent` 是 API 已按配置的父 id 解析好的 `objects` 下标（当时存在、没待删的；没有是 null）。不传时 `createLayer` 返回 null。
   */
  createLayer?(config: string, parent: number | null): number | null;
  /** 配置里带的脚本（克隆）当场追加进运行时并在返回前跑完 `init`（`ScriptRuntime.addScripts`）。不传时新对象上的脚本不跑。 */
  addScripts?(scripts: SceneScript[]): void;
}

/** `createLayer` 建出、还没有编译产物的对象（待编对象，P6d3b）：新 bundle 换上后删掉（`ScriptApi.adoptBundle`）。 */
interface PendingLayer {
  name: string;
  id: number;
  kind: CreatedLayerKind;
  /** 整理后的配置对象（数组配置是数组）；`getInitialLayerConfig` 取它的规整。 */
  config: Record<string, unknown> | unknown[];
}

/**
 * `IVideoTexture` 的落点（P9b）：视频纹理的播放器（`video/codecPlayer.ts` 的 `CodecVideoPlayer`）满足它。
 */
export interface VideoScriptTarget {
  rate: number;
  loop: boolean;
  currentTime: number;
  readonly duration: number;
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  addEndedCallback(callback: () => void): void;
}

/** 声音层脚本方法的落点（`audio/scheduler.ts` 的 `SoundScheduler` 满足它）：WPE `ISoundLayer` 的四个方法。 */
export interface SoundScriptTarget {
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
}

/**
 * 粒子层脚本方法的落点（P4f 步骤 3，`render/scene.ts` 的 `GpuScene.particleScript`）：WPE `IParticleSystem` 的五个方法，落到根
 * `ParticleSystem` 的 `scriptPlay` / `scriptPause` / `scriptStop` / `scriptIsPlaying` / `emitParticles`。`emitParticles` 收脚本的原始
 * 参数，归一化在模拟器里（`scriptEmitCount`）。
 */
export interface ParticleScriptTarget {
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  emitParticles(count?: unknown): void;
}

/** `ITextLayer` 运行中字段在 API 写入时的类型（rea-p6b-layout 6.2；p6b-api / p6b-api-enum 实测，步骤 2 的表）。 */
const TEXT_API_TYPES: Record<TextRuntimeField, ValueType | "string"> = {
  text: "string",
  horizontalalign: "string", // 枚举：ToString 后查表，查不到取表里第一项（宿主 `textFieldFromScript`）
  verticalalign: "string",
  pointsize: "float",
  maxwidth: "float",
  maxrows: "float", // 宿主截断取整
  padding: "vec2",
  spacing: "vec2",
  limitwidth: "bool",
  limitrows: "bool",
  limituseellipsis: "bool",
  blockalign: "bool",
};

/**
 * `engine.userProperties` 交给 `convertUserProperties` 的全集（P11d）：快捷方式项只带 `type` 与 `value`，脚本读到 `{}`（三个字段都是 undefined，
 * p11-REPORT「P11d 补测」：WPE 的 `engine.userProperties` 里始终如此，`init` 里、改值之后都一样）。`isbound` / `commandtype` / `file` 只在
 * `applyUserProperties` 的增量里给（宿主把全集项原样交过去），所以全集保留着它们，这里剥掉。
 */
export function scriptUserProperties(properties: ReadonlyMap<string, UserProperty>): Record<string, UserProperty> {
  const out: Record<string, UserProperty> = {};
  for (const [key, property] of properties)
    out[key] = property.type === "usershortcut" ? { type: property.type, value: property.value } : property;
  return out;
}

/** 路径的最后一段（`script.id` / 动画 `id` 的属性名）。 */
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const LAYER_FIELDS = [
  "origin",
  "scale",
  "angles",
  "alpha",
  "color",
  "visible",
  "brightness",
  "parallaxDepth",
  // 光标命中的开关（P6c）：所有图层都有，读回布尔，写入只收布尔（别的类型不写、不报错），没有改值回调，命中每帧现读
  "solid",
] as const;

/**
 * 脚本 realm 里的 WPE API。WPE 有、这里还没实现的成员登记在 `compile/scriptApi.ts` 的 `MISSING_SCRIPT_API`，
 * 编译期据此报 `script:api:*`、整张退回预览图；实现一个就从表里删一个（`api.test.ts` 双向核对）。
 */
export class ScriptApi {
  private current: SceneScript | null = null;
  private evaluating = false;
  private properties: ReadonlyMap<string, UserProperty> = new Map();
  private convertedProperties: Record<string, unknown> | null = null;
  private runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout" | "callFor"> | null = null;
  private readonly layers = new Map<number, ApiObject>();
  /** 图层的 `IVideoTexture`（P9b）：每个图层建一次，之后 `getVideoTexture()` 返回同一个对象（WPE 的 `L+0x4c0`）。 */
  private readonly videoTextures = new Map<number, ApiObject>();
  /** 写过不支持的灯字段（P13f2，`installLight`）：每个对象 / 字段只告警一次。 */
  private readonly warnedLightWrites = new Set<string>();
  private readonly materials = new Map<string, ApiObject>();
  private readonly effects = new Map<string, ApiObject>();
  /**
   * effect 的 `name`（P6d1a）：WPE 里 effect 描述符的 `name` 字段可读写、没有改值回调，只影响 `getEffect(名字)`。存在 API 这边，
   * API 对象跨重编译保留，所以名字也保留；没写过的取 `SceneEffect.name`。键同 `effects`：`<对象>/<JSON 下标>`。
   */
  private readonly effectNames = new Map<string, string>();
  /**
   * 图层的 `name`（P6d3b，`wpe-clone.log`：克隆体 `c.name = 'C1'` 之后 `enumerateLayers` 与 `thisLayer.name` 都是新名字）：同 effect 的 `name`，
   * 可读写字符串、存在 API 这边、跨重编译保留，影响之后按名字的查找（`lookup`）；没写过的取 `SceneLayer.name` / 待编对象建出时的名字。
   */
  private readonly layerNames = new Map<number, string>();
  /** `IAnimation` 包装对象（P10b）：按动画 `id`（`scene.json` 路径）缓存，同一条每次 `getAnimation` 返回同一个对象。 */
  private readonly animationApis = new Map<string, ApiObject>();
  /** `IAnimationLayer` 包装对象（P12c）：按 `<对象>:<层 id>` 缓存（P12e：id 稳定，运行中建删层下标会漂），`get(0) === get("walk")`。 */
  private readonly animationLayerApis = new Map<string, ApiObject>();
  /** 没有宿主视图时（语料诊断）的控制口替身：按 `<对象>:<层下标>` 缓存，保住脚本写过的名字等。 */
  private readonly fallbackLayerControls = new Map<string, PuppetLayerControl>();
  private readonly recompileValues = new Map<string, string>();
  /**
   * `createLayer` 的待编对象（P6d3b）：`objects` 下标 → 名字 / id / 类别 / 配置。没有 `SceneLayer`，所以存在性、名字、按类别装的成员
   * （声音、粒子、对齐、文本）读它；编进 bundle 后（`adoptBundle`）删掉。已知差异：自动尺寸的 `size`、`getEffect`、材质这些编译期字段，
   * 编译前读到的是缺省（WPE 当场就有，步骤 0：`bar.size` 是 `{4, 4}`）。
   */
  private readonly pending = new Map<number, PendingLayer>();
  /** 建出的对象的 id → `objects` 下标（整个会话保留，编进 bundle 后 `getLayerByID` 仍按建出时发的 id 找得到）。 */
  private readonly createdIds = new Map<number, number>();
  /**
   * 新图层 id 的下界（L4，`newLayerId`）：只增不减。换 bundle（`adoptBundle`，或 `newLayerId` 发现脚本看到的 bundle 换了）时取「当前 bundle 图层、已建
   * 对象与待编对象的 id 最大值 + 1」与旧值的较大者；之后登记表从活的 `bundle.layers` 摘掉最大 id 的层（L4 删除路径），这个 id 也不会再发（WPE 的 id
   * 不回收）。
   */
  private nextLayerId = 1;
  /** `nextLayerId` 上次按哪份 bundle 取的下界。 */
  private layerIdBundle: SceneBundle | null = null;
  /** `engine.registerAsset` 的登记表：脚本条目 id → 路径，只用来判同一段脚本重复登记（P6d3b 的 `__workshopId` 改写不读它，查的是编译期的 `bundle.assetPaths`）。 */
  private readonly registeredAssetsById = new Map<string, Set<string>>();
  /**
   * `engine.registerAudioBuffers` 的缓冲：同一分辨率返回同一个对象，由这里持有。`applySpectrum` 每帧把场景频谱（归一化后的）
   * 原地写进 `arrays`（P4e 步骤 4）；没有音频时频谱全零，相当于 WPE 里没有声音在放。`api` 是脚本拿到的对象，脚本可以改写
   * 它的字段，所以写入只认 `arrays`。
   */
  private readonly audioBufferCache = new Map<number, { api: ApiObject; arrays: AudioBuffers }>();
  /** 每段脚本写到重编译目标的次数（dev 探针诊断用）。 */
  readonly recompileWrites = new Map<string, number>();
  readonly engine: ApiObject;
  readonly thisScene: ApiObject;
  readonly general: ApiObject;

  constructor(
    private readonly realm: ScriptRealm,
    private readonly access: ScriptApiState,
  ) {
    this.engine = this.object();
    this.thisScene = this.object();
    this.general = this.object();
    this.installEngine();
    this.installInput();
    this.installScene();
    // general 字段在 `thisScene` 上也有（K5），和挂在 general 上的脚本的 `thisObject` 读写同一份
    this.installGeneral(this.general);
    this.installGeneral(this.thisScene);
    // `getAnimation`（P10b）：general 上的按 general 的属主找；不放进 installGeneral（它也装在 thisScene 上，那边是全场景查找）
    this.installGetAnimation(this.general, () => "general");
    this.realm.global.engine = this.engine;
    this.realm.global.thisScene = this.thisScene;
    this.define(this.realm.global, "thisLayer", () => {
      if (!this.current) return null;
      // 挂在 general 上的脚本没有图层，`thisLayer` 就是 `thisObject`（L14）
      return this.current.layer === null ? this.owner() : this.layer(this.current.layer);
    });
    this.define(this.realm.global, "thisObject", () => this.owner());
  }

  attachRuntime(runtime: Pick<ScriptRuntime, "setTimeout" | "setInterval" | "clearTimeout" | "callFor">): void {
    this.runtime = runtime;
  }
  enterScript(script: SceneScript | null): void {
    this.current = script;
  }
  setModuleEvaluating(evaluating: boolean): void {
    this.evaluating = evaluating;
  }
  /** 是否正在求值模块：realm 里挂的 WPE `localStorage` 用它做作用域检查。 */
  get moduleEvaluating(): boolean {
    return this.evaluating;
  }
  setProperties(full: ReadonlyMap<string, UserProperty>): void {
    this.properties = full;
    this.convertedProperties = null;
  }
  /** 用户绑定改变重编译目标后，下一次脚本写同一值仍需重新提交。 */
  forgetRecompile(path: string): void {
    this.recompileValues.delete(path);
  }
  /**
   * 把场景频谱拷进全部已注册分辨率的缓冲（P4e 步骤 4，「决定」5），脚本持有的数组不变。宿主每个实时帧在脚本之前调（渲染器推进频谱之后，
   * `SceneRendererOptions.beforeFrame`），暂停时不调、缓冲保持最后的值（同 WPE 整帧跳过时频谱冻结）。
   */
  applySpectrum(spectrum: Pick<SceneSpectrum, "block">): void {
    for (const [resolution, { arrays }] of this.audioBufferCache)
      copySpectrumToBuffers(spectrum.block(resolution as 16 | 32 | 64), arrays);
  }
  /** 已注册的音频分辨率，从小到大（dev 探针 `host.audio()` 用）。 */
  get audioResolutions(): number[] {
    return [...this.audioBufferCache.keys()].sort((a, b) => a - b);
  }
  /** 同一 objects 下标对应同一 API 对象，重编译只替换访问层里的 bundle 与 state。 */
  layer(object: number): ApiObject | null {
    if (!this.findLayer(object) && !this.pending.has(object)) return null;
    let api = this.layers.get(object);
    if (api) return api;
    api = this.object();
    this.ownerOf.set(api, object);
    const index = object;
    // `name`：可读写字符串（同 effect 的 `name`），写入照类型 5 的 `ToString`，`null` / `undefined` / 抛错的不写
    this.define(
      api,
      "name",
      () => this.nameOf(index) ?? "",
      (value) => {
        const text = scriptToString(value);
        if (text !== undefined) this.layerNames.set(index, text);
      },
    );
    // 图层字段与 `size` 的读取按 WPE 取单精度、角度按 f32 算法换成度（`f32.ts`，P3b 补测 `ignore/p3b-f32`）；状态照旧存 double
    this.define(
      api,
      "size",
      () => this.vector(scriptNumbers(this.findLayer(index)?.size ?? [0, 0]), 2),
      () => {},
    );
    for (const field of LAYER_FIELDS) {
      this.define(
        api,
        field,
        () => {
          const value = this.access.state().layers.get(index)?.[field];
          // `solid` 缺省真（P6c）
          if (field === "solid") return value !== false;
          // `parallaxDepth` 是 Vec2（P5a 步骤 2，WPE 声明 `parallaxDepth: Vec2`），其余向量是 Vec3
          if (Array.isArray(value))
            return this.vector(
              field === "angles" ? value.map((part) => radiansToScript(part)) : scriptNumbers(value),
              field === "parallaxDepth" ? 2 : 3,
            );
          return scriptNumber(value);
        },
        (value) => {
          const target: ApiTarget = { kind: "layer", object: index, field };
          this.write(
            target,
            value,
            field === "angles"
              ? "angles"
              : field === "visible" || field === "solid"
                ? "bool"
                : field === "alpha" || field === "brightness"
                  ? "float"
                  : field === "parallaxDepth"
                    ? "vec2"
                    : "vec3",
          );
        },
      );
    }
    // 按类别装的成员：已编译的看 `SceneLayer`，待编对象（P6d3b）看配置的类别。图像层的骨骼方法照装（WPE 建出就有，`wpe-bars` 的键数），
    // 编译前没有 puppet：计数 0、其余空操作
    const kind = this.pending.get(index)?.kind;
    if (this.isSoundLayer(index) || kind === "sound") this.installSound(api, index);
    // 灯对象（P13f2）：数值字段与类型 / 开关
    this.installLight(api, index);
    if (this.findLayer(index)?.particle || kind === "particle") this.installParticle(api, index);
    if (this.findLayer(index)?.alignment !== undefined || kind === "image") this.installAlignment(api, index);
    if (this.findLayer(index)?.text || kind === "text") this.installText(api, index);
    this.installHierarchy(api, index);
    this.installEffectAccess(api, index);
    // 视频纹理（P9b，决定 6）：所有图层都有这个方法，不是视频图层时返回 null
    this.method(api, "getVideoTexture", () => this.videoTexture(index));
    this.installGetAnimation(api, () => `objects/${index}`);
    this.installAnimationLayers(api, index);
    if (this.findLayer(index)?.alignment !== undefined || kind === "image") this.installBones(api, index);
    this.layers.set(object, api);
    return api;
  }

  /**
   * 层级与变换（P6d1a 点 2，rea-p6d1-xform、`p6d1-xform.log` / `p6d1-round2.log` 实测）：装在每个图层对象上。
   * - `getParent()`：父图层对象，根返回 `null`；`getChildren()`：每次新数组，`objects` 顺序。
   * - `getTransformMatrix()`：新 `Mat4`（自有键 `m`，16 个 f32），值 = 当前状态的 `drawMatrixOf`（世界矩阵 · 自身偏移），现算不读渲染器缓存。
   * - `rotateObjectSpace(v)` / `lookAt` / `lookAtYaw`：写 3×3 与角度（弧度原样），写入走普通 `angles` 同一个 `SceneState.write` 分支。
   */
  private installHierarchy(api: ApiObject, object: number): void {
    // 父与子表读状态（P6d3a：运行中会换父、删父；子表顺序 = 加载时 `objects` 顺序，换父挂上的追加在尾，`sortLayer` 不改它）
    this.method(api, "getParent", () => {
      const parent = this.access.state().layers.get(object)?.parent ?? null;
      return parent === null ? null : this.layer(parent);
    });
    this.method(api, "getChildren", () =>
      this.array(
        this.access
          .state()
          .childrenOf(object)
          .map((child) => this.layer(child)),
      ),
    );
    this.method(api, "setParent", (...args: unknown[]) => this.setParent(object, args));
    this.method(api, "getTransformMatrix", () => {
      const state = this.access.state();
      const m = this.access.transformMatrix?.(object) ?? drawMatrixOf(object, state.layers, new Map());
      const mat = (this.realm.global.Object as typeof Object).create(this.realm.prototypes.Mat4) as ApiObject;
      mat.m = this.array(Array.from(m));
      return mat;
    });
    this.method(api, "rotateObjectSpace", (v?: unknown) => {
      const layer = this.access.state().layers.get(object);
      if (!layer) return undefined;
      const R = layer.rotation ?? anglesRotation(layer.angles);
      const next = rotateObjectSpace(R, vec3Arg(v, [0, 0, 0]));
      this.access.write({ kind: "rotation", object, rotation: next, angles: extractEulerZYX(next) }, next);
      return undefined;
    });
    const lookAt = (name: "lookAt" | "lookAtYaw", compute: typeof lookAtAngles) =>
      this.method(api, name, (target?: unknown, up?: unknown) => {
        const layer = this.access.state().layers.get(object);
        if (!layer) return undefined;
        const eye = vec3Arg({ x: layer.origin[0], y: layer.origin[1], z: layer.origin[2] }, [0, 0, 0]);
        const camera = this.findLayer(object)?.camera != null;
        const angles = compute(eye, vec3Arg(target, [0, 0, 0]), vec3Arg(up, [0, 1, 0]), camera);
        // 结果是弧度，照 WPE 的角度 setter 原样写进（不经脚本的度 → 弧度换算，那会改末位）：走 `rotation` 目标、3×3 为 null（按角度
        // 重建）。视线与 up 平行时角度是 NaN（`p6d1-round2` 的 L3b、KN：WPE 读回 NaN），普通图层字段写入（`layerVectorValue`）会丢掉它
        if (angles) this.access.write({ kind: "rotation", object, rotation: null, angles: [...angles] }, [...angles]);
        return undefined;
      });
    lookAt("lookAt", lookAtAngles);
    lookAt("lookAtYaw", lookAtYawAngles);
  }

  /**
   * 图像层的 `alignment`（P8 步骤 3，rea-p8-layer 2.4，p8-REPORT `p8-par` 的 T）：只装在图像层上（`SceneLayer.alignment` 有值；WPE 的描述符
   * 只在图像层的属性表里，`IImageLayer.alignment: String`），别的图层上照旧是普通属性。读返回名字（WPE `0x140212610`）；写字符串查表、
   * 查不到或不是字符串写 `center`（`0x140212530`，`p8-par` 写数字 2 读回 `"center"`），以下标交给宿主（`[下标]`，重放表也存这个形状），
   * `SceneState` 就地重算偏移、标脏，同帧生效。
   */
  private installAlignment(api: ApiObject, object: number): void {
    this.define(
      api,
      "alignment",
      () => alignmentName(this.access.state().layers.get(object)?.alignment),
      (value) => this.write({ kind: "layer", object, field: "alignment" }, alignmentIndex(value), "float"),
    );
  }

  /**
   * 文本层的 `ITextLayer`（P6b 步骤 2）：只装在文本层上（WPE 的描述符只在文本对象的表里），12 个运行中字段。读 `textFields` 的当前值，
   * 按 WPE 读回的形状交出（float 按 f32、`padding` / `spacing` 是 Vec2）；写经 `write()` 落到 `{ kind: "text" }`，宿主规整后当帧重排。
   * 另装非运行中的 `font`、`opaquebackground`、`backgroundbrightness`、`anchor`（整场重编译）与 `backgroundcolor`（同属性绑定的目标，
   * LDR 下就地），见下（点 5）。
   */
  private installText(api: ApiObject, object: number): void {
    for (const field of TEXT_RUNTIME_FIELDS)
      this.define(
        api,
        field,
        () => {
          const value = this.access.state().textFields.get(object)?.[field];
          if (Array.isArray(value)) return this.vector(value, 2);
          return typeof value === "number" ? Math.fround(value) : value;
        },
        (value) => this.write({ kind: "text", object, field }, value, TEXT_API_TYPES[field]),
      );
    // 非运行中字段（点 5）：WPE 里写入当场生效，我们走整场重编译（`backgroundcolor` 就地时除外）。读回先看这个路径待生效的写入值
    const target = (key: string): ApiTarget => ({
      kind: "recompile",
      reason: "layer-structure",
      path: `objects/${object}/${key}`,
    });
    const pending = (path: string): unknown => {
      const encoded = this.recompileValues.get(path);
      return encoded === undefined ? undefined : JSON.parse(encoded);
    };
    const script = () => this.findLayer(object)?.text?.script;
    const recompiled = (key: string, compiled: () => unknown, type: "string" | "bool" | "float") =>
      this.define(
        api,
        key,
        () => {
          const value = pending(`objects/${object}/${key}`);
          if (value === undefined) return compiled();
          return type === "float" ? Math.fround((value as number[])[0]) : value;
        },
        (value) => this.write(target(key), value, type),
      );
    const fields = () => this.access.state().textFields.get(object);
    recompiled("font", () => fields()?.font, "string");
    recompiled("opaquebackground", () => fields()?.opaquebackground, "bool");
    recompiled("backgroundbrightness", () => Math.fround(script()?.backgroundbrightness ?? 1), "float");
    this.define(
      api,
      "anchor",
      () => pending(`objects/${object}/anchor`) ?? script()?.anchor,
      (value) => {
        // 枚举先在这里规整（ToString，查不到取表里第一项 none），重编译读到的就是名字
        const text = scriptToString(value);
        if (text === undefined) return;
        this.write(target("anchor"), (TEXT_ANCHORS as readonly string[]).includes(text) ? text : "none", "string");
      },
    );
    // `backgroundcolor` 的目标同属性绑定（编译期定）：就地的背景常量，或（HDR 下亮度不为 1）重编译
    this.define(
      api,
      "backgroundcolor",
      () => {
        const info = script();
        if (!info) return undefined;
        const goal = info.backgroundTarget;
        let value: unknown;
        if (goal.kind === "recompile") value = pending(goal.path);
        else if (goal.kind === "constant") value = this.access.state().constants.get(goal.pass)?.[goal.uniforms[0]];
        return this.vector((value as number[] | undefined) ?? info.backgroundcolor, 3);
      },
      (value) => {
        const goal = script()?.backgroundTarget;
        if (goal) this.write(goal, value, "vec3");
      },
    );
  }

  /** 是不是声音对象的图层：声音表里有它（对象类别跨重编译不变，图层代理建一次就定）。 */
  private isSoundLayer(object: number): boolean {
    return this.access.bundle().sounds?.some((sound) => sound.object === object) ?? false;
  }

  /**
   * 灯对象的成员（P13f2，`p13f-light` 的 L2 实测形状）：12 个数值字段（`LIGHT_FIELDS`，读回 float32，`controlpoint` 是 Vec3）读写
   * `SceneState.lights`，写入走同一个 `SceneState.write`（当帧进灯光 uniform）；`light` 读出类型字符串，`castshadow` / `castvolumetrics` /
   * `usecookie` 读出布尔。后四个 WPE 运行中改会重建灯的资源，这里不支持：写入只记一次 warn、不改（语料 0，待定 4、5）。
   */
  private installLight(api: ApiObject, object: number): void {
    const light = this.access.bundle().lightObjects?.find((item) => item.object === object);
    if (!light) return;
    for (const field of Object.keys(LIGHT_FIELDS) as LightField[]) {
      const type = LIGHT_FIELDS[field].type;
      this.define(
        api,
        field,
        () => {
          const value = this.access.state().lights.get(object)?.[field];
          return Array.isArray(value) ? this.vector(scriptNumbers(value), 3) : scriptNumber(value);
        },
        (value) => this.write({ kind: "light", object, field }, value, type),
      );
    }
    const readOnly = (name: string, read: () => unknown) =>
      this.define(api, name, read, () => {
        // TODO:[WPE_SCENE] 运行中改灯的类型 / 阴影 / cookie / 体积光开关（WPE 重建灯资源，rea-p13-lights 3.1 的 `0x14025c610`）没做，语料 0
        if (!this.warnedLightWrites.has(`${object}/${name}`)) {
          this.warnedLightWrites.add(`${object}/${name}`);
          const message = `场景脚本写灯的 ${name} 暂不支持（对象 ${object}）`;
          if (this.access.warn) this.access.warn(message);
          else console.warn(message);
        }
      });
    readOnly("light", () => light.light);
    readOnly("castshadow", () => (light.flags & 1) !== 0);
    readOnly("usecookie", () => (light.flags & 2) !== 0);
    readOnly("castvolumetrics", () => light.castVolumetrics);
  }

  /**
   * 声音层的 `ISoundLayer`（P6a 步骤 2，rea-p6a-sound.md 第 7 节）：只登记在声音对象的图层上（WPE 的方法表按对象类型登记），
   * 其它图层上调用照旧是 `TypeError`；粒子层的同名方法另由 `installParticle` 登记在粒子对象上（P4f 步骤 3）。
   * 四个方法直接接到排期器（`play` = `P`、`stop` = `X`），
   * `volume` 读 `SceneState.sounds`、写落到就地目标 `{ kind: "sound" }`，不钳制（增益在乘积上钳，`audio/scheduler.ts`），
   * 宿主写完当场交给排期器（WPE 的回调 `V`，暂停时也生效）。
   */
  private installSound(api: ApiObject, object: number): void {
    const target = () => this.access.sound?.(object) ?? null;
    this.method(api, "play", () => {
      target()?.play();
    });
    this.method(api, "pause", () => {
      target()?.pause();
    });
    this.method(api, "stop", () => {
      target()?.stop();
    });
    this.method(api, "isPlaying", () => target()?.isPlaying() ?? false);
    // TODO:[WPE_SCENE] 没实测：`volume` 读回仍是 double；图层字段与材质常量实测是 f32（P3b 补测 `ignore/p3b-f32`），这里大概率同样，
    // 测过再按 `f32.ts` 改
    this.define(
      api,
      "volume",
      () => this.access.state().sounds.get(object)?.volume,
      (value) => this.write({ kind: "sound", object, field: "volume" }, value, "float"),
    );
  }

  /**
   * 图层的 `IVideoTexture`（P9b，rea-p9-video 第 6 节，类型与顺序照 p9-REPORT「P9b 步骤 0 的补测」）。基础材质槽 0 是视频纹理时
   * 第一次调用建包装对象并缓存，之后返回同一个；不是视频图层时返回 null、不缓存（「是不是视频」只看 bundle，`layerVideoSource`）。
   * 包装对象不持有播放器：每次调用经 `access.video` 按区间现取，没有落点（语料诊断、播放器已释放）时方法空操作。
   * 自有属性按 WPE 的 `Object.keys` 顺序逐个定义，都可枚举：
   * - `duration`：只读访问器（严格模式下写入抛 TypeError），落点时长的 float32；没有落点时取 bundle 里的容器时长，再没有 0。
   * - `loop` / `rate`：包装对象自己的字段（WPE 的 `V+0xec` / `V+0xe8`），读只返回字段、不问播放器；写入转换后存字段并转给落点。
   *   `loop` 读出数字 1 / 0（实测，和 WPE 自带的 `.d.ts` 不同），`rate` 是 float32、写入不是有限数时不写。
   * - `addEndedCallback`：登记时记下当前脚本，触发时经运行时 `callFor` 进入那段脚本的上下文、不带参数调用。
   * - `getAnimation`：返回 undefined（WPE 有这个成员）。
   */
  private videoTexture(object: number): ApiObject | null {
    if (!layerVideoSource(this.access.bundle(), object)) return null;
    let api = this.videoTextures.get(object);
    if (api) return api;
    api = this.object();
    const target = () => this.access.video?.(object) ?? null;
    let loop = true;
    let rate = 1;
    this.define(api, "duration", () => {
      const player = target();
      return Math.fround(player ? player.duration : (layerVideoSource(this.access.bundle(), object)?.duration ?? 0));
    });
    this.define(
      api,
      "loop",
      () => (loop ? 1 : 0),
      (value) => {
        loop = Boolean(value);
        const player = target();
        if (player) player.loop = loop;
      },
    );
    this.define(
      api,
      "rate",
      () => rate,
      (value) => {
        const next = Math.fround(Number(value));
        if (!Number.isFinite(next)) return;
        rate = next;
        // 负数、超出 Chromium 范围由播放器处理（钳到 0 / 保持原速率）；字段照存，同 WPE 读只返回字段
        const player = target();
        if (player) player.rate = next;
      },
    );
    this.method(api, "addEndedCallback", (callback: unknown) => {
      if (typeof callback !== "function") throw new TypeError("addEndedCallback 需要回调函数");
      // 登记到当时取得的落点上（播放器跨重编译按区间复用，登记过的回调跟着它走）；没有落点时没有东西会结束，不登记。
      // 回调经运行时调用：进入登记它的那段脚本的上下文、计时，出错只记诊断、不禁用，同计时器
      const owner = this.current?.id;
      const player = target();
      if (!player || owner === undefined) return;
      player.addEndedCallback(() => this.runtime?.callFor(owner, () => (callback as () => unknown)()));
    });
    this.method(api, "play", () => {
      target()?.play();
    });
    this.method(api, "setCurrentTime", (time: unknown) => {
      const player = target();
      if (player) player.currentTime = Number(time);
    });
    this.method(api, "isPlaying", () => target()?.isPlaying() ?? false);
    this.method(api, "stop", () => {
      target()?.stop();
    });
    this.method(api, "pause", () => {
      target()?.pause();
    });
    this.method(api, "getCurrentTime", () => {
      const player = target();
      return player ? Math.fround(player.currentTime) : 0;
    });
    this.method(api, "getAnimation", () => undefined);
    this.videoTextures.set(object, api);
    return api;
  }

  /**
   * 粒子层的 `IParticleSystem`（P4f 步骤 3，rea-p4f-script.md 1.1–1.3）：只登记在粒子对象的图层上（WPE 的反射表 `FUN_14024cb00` 按对象
   * 类型登记，同 `installSound`），其它图层上调用照旧是 `TypeError`。子系统与事件实例脚本拿不到（1.5）。
   * - 五个方法接到宿主给的根系统（`ScriptApiState.particles`）：`play` / `pause` / `stop` / `isPlaying` / `emitParticles(count)`，都当场
   *   生效（语义见 `ParticleSystem.scriptPlay` 等）；`emitParticles` 把脚本的原始参数交过去，归一化在模拟器里（缺参数、0、非整数都是 1，
   *   负数不发）。没有落点时什么都不做，`isPlaying` 为假。
   * - `instance`：只读字段（`+0x60 = 2`；整体赋值忽略，同 `size`），值是一个固定的子对象（`particleInstance`），每次读都是同一个。
   */
  private installParticle(api: ApiObject, object: number): void {
    const target = () => this.access.particles?.(object) ?? null;
    this.method(api, "play", () => {
      target()?.play();
    });
    this.method(api, "pause", () => {
      target()?.pause();
    });
    this.method(api, "stop", () => {
      target()?.stop();
    });
    this.method(api, "isPlaying", () => target()?.isPlaying() ?? false);
    this.method(api, "emitParticles", (count?: unknown) => {
      target()?.emitParticles(count);
    });
    const instance = this.particleInstance(object);
    this.define(
      api,
      "instance",
      () => instance,
      () => {},
    );
  }

  /**
   * 粒子层的 `instance` 子对象（P4f 步骤 3，rea-p4f-script.md 1.3、5.1，WPE `io` 的描述符 `0x1404e8860`，24 个字段、没有方法）：
   * - 读：`SceneState.particleInstances` 里的覆盖值（WPE 的 `io`，写完当场就能读回）。系数是数字；`colorn` 没设过是 (−1, −1, −1)；控制点
   *   `controlpointN` / `controlpointangleN` 没设过是 (FLT_MAX, 0, 0)（实测 `a-inst-cp`），读到的是覆盖值、不是控制点的实际位置。`rate`
   *   读到的是状态里的值：单写的原值，或重算 / 加载时钳过的值（5.2、5.4）。
   * - 写：经现有的就地目标 `particle-instance`（和用户属性、字段脚本同一个 setter）：系数按 float、`colorn` 与控制点按 vec3（数字铺满、
   *   `Vec3` / `{x, y, z}`），`controlpointangleN` 是弧度、不换算（`+0x60` 没有角度位，1.3）。除 `rate` 外置脏，下一帧开头重算（5.2、5.3）；
   *   `rate` 只改步进率（5.4，P4f 步骤 1 的单独路径）。同一段脚本里先写的系数对随后 `emitParticles` 的这批不生效（4.4）。
   * 没有这一层的状态时读到 undefined。
   *
   * TODO:[WPE_SCENE] 没实测：系数、`colorn`、控制点的读回仍是 double；图层字段与材质常量实测是 f32（P3b 补测 `ignore/p3b-f32`），
   * 这里大概率同样（`FLT_MAX` 本身是 f32 能表示的值），测过再按 `f32.ts` 改。
   */
  private particleInstance(object: number): ApiObject {
    const api = this.object();
    const values = () => this.access.state().particleInstances.get(object);
    for (const field of INSTANCE_FIELDS)
      this.define(
        api,
        field,
        () => values()?.[field],
        (value) => this.write({ kind: "particle-instance", object, field }, value, "float"),
      );
    this.define(
      api,
      "colorn",
      () => {
        const current = values();
        return current ? this.vector(current.colorn ?? [-1, -1, -1], 3) : undefined;
      },
      (value) => this.write({ kind: "particle-instance", object, field: "colorn" }, value, "vec3"),
    );
    for (const key of INSTANCE_CONTROL_POINT_KEYS) {
      const point = instanceControlPoint(key)!;
      this.define(
        api,
        key,
        () => {
          const current = values();
          if (!current) return undefined;
          const list = point.angle ? current.controlpointAngles : current.controlpoints;
          return this.vector(list[point.index] ?? [FLT_MAX, 0, 0], 3);
        },
        (value) => this.write({ kind: "particle-instance", object, field: key }, value, "vec3"),
      );
    }
    return api;
  }

  private object(): ApiObject {
    // 普通对象，不是 `create(null)`：WPE 的 `String(thisObject)` 是 `[object Object]`，没有原型时会抛 TypeError
    return new (this.realm.global.Object as ObjectConstructor)() as ApiObject;
  }
  /**
   * 属主对象被删（`destroyLayer` 生效）之后作废（P6d3a，rea-p6d-layers 6.3）：图层对象、它的 effect 与材质对象登记进 `ownerOf`，
   * 之后读字段得 `undefined`、写入忽略、方法返回 `undefined`（不抛错）。没登记的对象（`thisScene`、`engine`、general）不受影响。
   */
  private readonly ownerOf = new WeakMap<ApiObject, number>();
  /** 对象还在：没有生效的删除（`SceneState.layers` 里有）。 */
  private alive(object: number): boolean {
    return this.access.state().layers.has(object);
  }
  /**
   * 动画层包装（P12e）：包装对应的 `<对象, 层 id>`。属主对象被删、或这一层已被释放（单次层播完被删、`destroyAnimationLayer` 在 `settle` 里释放）
   * 之后同样作废：读字段 `undefined`、写忽略、方法返回 `undefined`、`engine.isObjectValid` 为假。
   */
  private readonly animationLayerOf = new WeakMap<ApiObject, { object: number; id: number }>();
  private dead(object: ApiObject): boolean {
    const owner = this.ownerOf.get(object);
    if (owner !== undefined && !this.alive(owner)) return true;
    const layer = this.animationLayerOf.get(object);
    return layer !== undefined && (!this.alive(layer.object) || !this.puppetView(layer.object).alive(layer.id));
  }
  private define(object: ApiObject, name: string, get: () => unknown, set?: (value: unknown) => void): void {
    (this.realm.global.Object as typeof Object).defineProperty(object, name, {
      enumerable: true,
      get: () => (this.dead(object) ? undefined : get()),
      ...(set
        ? {
            set: (value: unknown) => {
              if (!this.dead(object)) set(value);
            },
          }
        : {}),
    });
  }
  private method(object: ApiObject, name: string, fn: (...args: never[]) => unknown, scoped = false): void {
    // 方法的取值照常返回函数（作废后调用也不抛错），调用时才看属主还在不在
    (this.realm.global.Object as typeof Object).defineProperty(object, name, {
      enumerable: true,
      get:
        () =>
        (...args: never[]) => {
          if (this.dead(object)) return undefined;
          if (scoped) this.requireCallback(name);
          return fn(...args);
        },
    });
  }
  private requireCallback(name: string): void {
    requireCallbackContext(name, this.evaluating);
  }
  /** 与 `requireCallback` 相反：只能模块顶层调用的 API（报告 D）。 */
  private requireEvaluating(name: string): void {
    if (!this.evaluating) throw new Error(`${name} 只能在模块求值期间调用`);
  }
  private vector(values: readonly number[], size: 2 | 3 | 4): unknown {
    const prototype = this.realm.prototypes[`Vec${size}`];
    const ctor = (prototype as { constructor: new (...values: number[]) => unknown }).constructor;
    return new ctor(...values.slice(0, size));
  }
  private array(values: unknown[]): unknown[] {
    const ctor = this.realm.global.Array as ArrayConstructor;
    return ctor.from(values);
  }
  /** 初始全零的 `{ left, right, average }`，元素是 realm 的 `Float32Array`；同一分辨率返回同一个对象。 */
  private audioBuffer(resolution: unknown): ApiObject {
    if (resolution !== 16 && resolution !== 32 && resolution !== 64)
      throw new TypeError(`registerAudioBuffers 只接受 16、32、64，收到 ${String(resolution)}`);
    const size = resolution as 16 | 32 | 64;
    const cached = this.audioBufferCache.get(size);
    if (cached) return cached.api;
    const ctor = this.realm.global.Float32Array as Float32ArrayConstructor;
    const arrays: AudioBuffers = { left: new ctor(size), right: new ctor(size), average: new ctor(size) };
    const api = this.object();
    api.left = arrays.left;
    api.right = arrays.right;
    api.average = arrays.average;
    this.audioBufferCache.set(size, { api, arrays });
    return api;
  }
  private findLayer(object: number): SceneLayer | undefined {
    return this.access.bundle().layers.find((layer) => layer.object === object);
  }
  private write(target: ApiTarget, raw: unknown, type: ValueType | "string"): void {
    let value: ScriptValue;
    if (type === "bool") {
      if (typeof raw !== "boolean") return;
      value = raw;
    } else if (type === "string") {
      // 字符串只交给文本目标与重编译目标（`font`、`anchor`，P6b 步骤 2 点 5；1e 起同运行时的 `writeReturn`）：WPE 类型 5 的 `ToString`，
      // `null` / `undefined` 与抛错的不写
      if (target.kind !== "text" && target.kind !== "recompile" && target.kind !== "pass-state") return;
      const text = scriptToString(raw);
      if (text === undefined) return;
      value = text;
    } else {
      const size = type === "float" ? 1 : type === "vec2" ? 2 : type === "vec4" ? 4 : 3;
      if (typeof raw === "number") value = Array(size).fill(raw);
      else if (raw && typeof raw === "object") {
        const parts = ["x", "y", "z", "w"].slice(0, size).map((key) => (raw as ApiObject)[key]);
        if (!parts.every((part) => typeof part === "number")) return;
        value = parts as number[];
      } else return;
      // 角度按 WPE 的 f32 乘法换成弧度（`f32.ts`）；其余数原样交给宿主（下一次读时再取 f32）
      if (type === "angles") value = value.map((part) => degreesFromScript(part));
    }
    if (target.kind === "recompile") {
      const id = this.current?.id ?? "<module>";
      this.recompileWrites.set(id, (this.recompileWrites.get(id) ?? 0) + 1);
      const encoded = JSON.stringify(value);
      if (this.recompileValues.get(target.path) === encoded) return;
      if (this.access.write(target, value)) this.recompileValues.set(target.path, encoded);
      return;
    }
    this.access.write(target, value);
  }
  private owner(): ApiObject | null {
    const owner = this.current?.owner;
    if (!owner) return null;
    if (owner.kind === "layer") return this.layer(owner.object);
    // 动画层字段脚本（P12c）：`thisObject` 是那个 IAnimationLayer（`thisLayer` 仍是所属图层，取 `current.layer`）
    if (owner.kind === "animation-layer") return this.animationLayerApi(owner.object, owner.layer);
    if (owner.kind === "general") return this.general;
    if (owner.kind === "effect") return this.effect(owner.object, owner.effect);
    return this.material(owner.pass);
  }

  private installEngine(): void {
    const scoped = (name: string, get: () => unknown) =>
      this.define(this.engine, name, () => {
        this.requireCallback(name);
        return get();
      });
    scoped("frametime", () => this.access.frametime());
    scoped("runtime", () => this.access.runtime());
    scoped("timeOfDay", () => this.access.timeOfDay());
    scoped("canvasSize", () =>
      this.vector([this.access.bundle().general.width, this.access.bundle().general.height], 2),
    );
    scoped("screenResolution", () => this.vector(this.access.screenResolution(), 2));
    scoped("userProperties", () => {
      if (!this.convertedProperties)
        // 键按 WPE 的字节序（`scriptPropertyEntries`），同 `applyUserProperties` 的参数
        this.convertedProperties = this.realm.internal.convertUserProperties(
          JSON.stringify(
            Object.fromEntries(scriptPropertyEntries(Object.entries(scriptUserProperties(this.properties)))),
          ),
        );
      return this.convertedProperties;
    });
    // 快捷方式（P11d，p11-REPORT「P11d 补测」门禁表）：只在三个光标回调里能调，否则抛 realm 的 `SyntaxError`；参数不是字符串原始值
    // 返回 false 且不消耗令牌；之后取令牌，没有就抛；然后查属性（令牌在查属性之前就消耗了）。方法本身不是 scoped：模块求值期间调同样落到
    // 「不在光标回调里」。`true` 只表示宿主受理（WPE 的 `true` 是 `ShellExecuteW` 成功，我们的启动在应用页异步完成，已知差异）
    this.method(this.engine, "openUserShortcut", (...args: unknown[]) => {
      const callback = this.access.activeCallback?.() ?? null;
      if (callback !== "cursorClick" && callback !== "cursorDown" && callback !== "cursorUp")
        throw this.syntaxError("Cannot execute user command outside of cursor callbacks.");
      if (args.length < 1 || typeof args[0] !== "string") return false;
      const result = this.access.openUserShortcut?.(args[0]) ?? 0;
      if (result === 2) throw this.syntaxError("Cannot execute more than one user command per cursor click.");
      return result === 1;
    });
    this.method(this.engine, "isRunningInEditor", () => false);
    this.method(this.engine, "isMobileDevice", () => false);
    this.method(this.engine, "isDesktopDevice", () => true);
    this.method(this.engine, "isWallpaper", () => true);
    this.method(this.engine, "isScreensaver", () => false);
    this.method(
      this.engine,
      "isPortrait",
      () => {
        const [width, height] = this.access.screenResolution();
        return height > width;
      },
      true,
    );
    this.method(
      this.engine,
      "isLandscape",
      () => {
        const [width, height] = this.access.screenResolution();
        return width >= height;
      },
      true,
    );
    this.method(
      this.engine,
      "isObjectValid",
      (value: unknown) =>
        [...this.layers.entries()].some(
          ([index, layer]) => layer === value && !!this.findLayer(index) && this.alive(index),
        ) ||
        value === this.general ||
        // 动画层包装（P12e）：层还没被释放、属主对象还在（实测活着的层是 true）
        (typeof value === "object" &&
          value !== null &&
          this.animationLayerOf.has(value as ApiObject) &&
          !this.dead(value as ApiObject)) ||
        [...this.materials.entries()].some(
          ([pass, object]) => object === value && this.access.state().constants.has(pass) && !this.dead(object),
        ) ||
        [...this.effects.entries()].some(([key, object]) => {
          if (object !== value || this.dead(object)) return false;
          const [layer, effect] = key.split("/").map(Number);
          return this.findLayer(layer)?.effects.some((item) => item.source === effect) ?? false;
        }),
    );
    this.engine.AUDIO_RESOLUTION_16 = 16;
    this.engine.AUDIO_RESOLUTION_32 = 32;
    this.engine.AUDIO_RESOLUTION_64 = 64;
    // 只能在模块顶层调（报告 D），回调里调用抛错；只收 16 / 32 / 64，其它值抛 TypeError
    this.method(this.engine, "registerAudioBuffers", (resolution: unknown) => {
      this.requireEvaluating("registerAudioBuffers");
      const buffers = this.audioBuffer(resolution);
      this.access.audioRegistered?.();
      return buffers;
    });
    // 登记资源（P6d3a，rea-p6d-script 第 3 节）：只能在模块顶层调；参数不是字符串返回 null；同一段脚本重复登记同一路径返回 null；
    // 否则记进这段脚本的登记表（P6d3b 的 `__workshopId` 改写用）并返回路径本身。WPE 的 exe 不读这张表，所以 precache 什么都不做
    this.method(this.engine, "registerAsset", (path?: unknown, _precache?: unknown) => {
      if (!this.evaluating) throw this.syntaxError("registerAsset can only be called from global scope.");
      if (typeof path !== "string") return null;
      const id = this.current?.id ?? "<module>";
      const set = this.registeredAssetsById.get(id) ?? new Set<string>();
      if (set.has(path)) return null;
      set.add(path);
      this.registeredAssetsById.set(id, set);
      return path;
    });
    this.method(
      this.engine,
      "setTimeout",
      (callback: unknown, delay = 0) => {
        if (typeof callback !== "function") throw new TypeError("setTimeout 需要回调函数");
        if (!this.runtime) throw new Error("脚本运行时尚未连接");
        return this.runtime.setTimeout(callback as () => void, Number(delay));
      },
      true,
    );
    this.method(
      this.engine,
      "setInterval",
      (callback: unknown, delay = 0) => {
        if (typeof callback !== "function") throw new TypeError("setInterval 需要回调函数");
        if (!this.runtime) throw new Error("脚本运行时尚未连接");
        return this.runtime.setInterval(callback as () => void, Number(delay));
      },
      true,
    );
    this.method(
      this.engine,
      "clearTimeout",
      (cancel: unknown) => {
        if (typeof cancel !== "function") throw new TypeError("clearTimeout 需要取消函数");
        this.runtime?.clearTimeout(cancel as () => void);
      },
      true,
    );
  }

  /**
   * 全局 `input`（P6c，rea-p6c-script.md 3、p6-REPORT 0c）：三个只读成员，每次读都现取、建新对象（`input.cursorWorldPosition ===
   * input.cursorWorldPosition` 为假）：`cursorWorldPosition` 是 `Vec3`（同回调的 `worldPosition`，正交 z = 0）、`cursorScreenPosition` 是
   * `Vec2`（窗口客户区像素，左上原点、y 向下，和 `engine.screenResolution` 同一套单位）、`cursorLeftDown` 是布尔。模块求值期间（顶层）读
   * 抛 realm 的 `SyntaxError: <成员名> cannot be accessed from global scope.`，`init`、`update`、回调、计时器里都能读。成员只有 getter：严格模式
   * 下赋值抛 `TypeError`（WPE 是只读数据属性）。
   */
  private installInput(): void {
    const input = this.object();
    const snapshot = (): CursorInputSnapshot =>
      this.access.cursorInput?.() ?? { world: [0, 0, 0], screen: [0, 0], leftDown: false };
    const scoped = (name: string, get: () => unknown) =>
      this.define(input, name, () => {
        if (this.evaluating) {
          const Ctor = (this.realm.global.SyntaxError as ErrorConstructor | undefined) ?? SyntaxError;
          throw new Ctor(`${name} cannot be accessed from global scope.`);
        }
        return get();
      });
    scoped("cursorWorldPosition", () => this.vector(scriptNumbers(snapshot().world), 3));
    scoped("cursorScreenPosition", () => this.vector(scriptNumbers(snapshot().screen), 2));
    scoped("cursorLeftDown", () => snapshot().leftDown);
    this.realm.global.input = input;
  }

  /** realm 里的 `SyntaxError`（WPE 的宿主抛的就是它，`instanceof Error` 为真；同 `input` 与 `getAnimation`）。 */
  private syntaxError(message: string): Error {
    const Ctor = (this.realm.global.SyntaxError as ErrorConstructor | undefined) ?? SyntaxError;
    return new Ctor(message);
  }

  /** 模块求值期间调 `getAnimation` 抛 realm 的 SyntaxError，消息照 WPE（P10b 步骤 0 Q5）。 */
  private requireAnimationContext(): void {
    if (!this.evaluating) return;
    const Ctor = (this.realm.global.SyntaxError as ErrorConstructor | undefined) ?? SyntaxError;
    throw new Ctor("getAnimation cannot be called from global scope.");
  }

  /**
   * 对象上的 `getAnimation`（P10b，IObject）：装在图层、effect、材质、general 的 API 对象上（`thisScene` 的另见 `installScene`）。
   * 只在这个对象的属主里找（`owner` 是动画的属主路径，同联动：图层 `objects/<i>`、effect `objects/<i>/effects/<e>`、材质
   * `<pass>/constantshadervalues`、`general`；步骤 0 Q1，不是按图层找）。参数是非空字符串时用它，否则（空串、非字符串、不带参数）
   * 取当前脚本所挂属性的名字（`script.id` 的最后一段，Q6），没有当前脚本时是空串；找不到返回 undefined。
   */
  private installGetAnimation(api: ApiObject, owner: () => string): void {
    this.method(api, "getAnimation", (name?: unknown) => {
      this.requireAnimationContext();
      const wanted = typeof name === "string" && name !== "" ? name : this.current ? lastSegment(this.current.id) : "";
      const def = this.findAnimation(owner(), wanted);
      return def ? this.animationApi(def) : undefined;
    });
  }

  /**
   * 在脚本看到的 bundle 里按列表顺序（= WPE 的登记顺序）找第一条：`owner` 不为 null 时属主相同，名字等于 `options.name` 或属性名
   * （`id` 的最后一段）。跳过 WPE 不建绑定的（常量目标在着色器里没有 uniform，`settleConstantAnimation` 已标出）；丢弃的（`inert`）找得到。
   */
  private findAnimation(owner: string | null, name: string): SceneAnimation | undefined {
    for (const def of this.access.bundle().animations ?? []) {
      if (owner !== null && def.owner !== owner) continue;
      if (def.target.kind === "constant" && def.target.uniforms.length === 0) continue;
      if (def.name === name || lastSegment(def.id) === name) return def;
    }
    return undefined;
  }

  /**
   * `IAnimation` 包装对象（P10b，步骤 0 Q4，rea-p10-keyframes 第 11 节）：按 `id` 缓存。不持有播放器：方法每次经 `access.animation` 现取落点
   * （重编译换了播放器也控制同一条、`rate` 保留），没有落点时空操作、`isPlaying()` 假、`getFrame()` 0。12 个自有可枚举成员，顺序
   * `name`、`frameCount`、`duration`、`fps`、`rate`、`play`、`isPlaying`、`stop`、`pause`、`setFrame`、`getFrame`、`getAnimation`：
   * - 前四个是不可写的数据属性，值在建对象时按这一条的时钟取（不会变），严格模式下赋值抛 V8 自己的 TypeError（WPE 同一条消息）；
   * - `rate` 是访问器：只收 number（`NaN` 也收，转 float32），别的忽略；描述符和 WPE 的原生数据属性不同，记为已知差异；
   * - 方法是数据属性（函数对象建一次）；`setFrame(f)` 的 `f` 不是 number 时按 0；`getAnimation()` 返回 undefined（同 IVideoTexture）；
   * - 原型是普通的 `Object.prototype`（WPE 是只有 `constructor` 的原型），记为已知差异。
   */
  private animationApi(def: SceneAnimation): ApiObject {
    const id = def.id;
    let api = this.animationApis.get(id);
    if (api) return api;
    api = this.object();
    const target = () => this.access.animation?.(id) ?? null;
    const info = target();
    const clock = info ? null : def.inert ? AnimationClock.inert(def.clock.length) : new AnimationClock(def.clock);
    const Obj = this.realm.global.Object as typeof Object;
    const constant = (key: string, value: unknown) =>
      Obj.defineProperty(api, key, { value, enumerable: true, writable: false, configurable: false });
    const method = (key: string, run: (...args: unknown[]) => unknown) =>
      Obj.defineProperty(api, key, { value: run, enumerable: true, writable: true, configurable: true });
    constant("name", info?.name ?? def.name);
    constant("frameCount", info?.frameCount ?? clock!.length);
    constant("duration", info?.duration ?? clock!.D);
    constant("fps", info?.fps ?? Math.fround(1 / clock!.spf));
    Obj.defineProperty(api, "rate", {
      enumerable: true,
      configurable: true,
      get: () => target()?.rate ?? 1,
      set: (value: unknown) => {
        const control = target();
        // 只收数字，`NaN` 也收（Q4）：别的类型（字符串、对象、布尔）忽略，不做类型转换
        if (control && typeof value === "number") control.rate = Math.fround(value);
      },
    });
    method("play", () => void target()?.play());
    method("isPlaying", () => target()?.isPlaying() ?? false);
    method("stop", () => void target()?.stop());
    method("pause", () => void target()?.pause());
    method("setFrame", (frame) => void target()?.setFrame(typeof frame === "number" ? frame : 0));
    method("getFrame", () => target()?.getFrame() ?? 0);
    method("getAnimation", () => undefined);
    this.animationApis.set(id, api);
    return api;
  }

  /** 对象的 puppet 运行时数据（bundle 里的定义）：skinned puppet 或带骨骼的模型，别的为 null（P12c）。 */
  private puppetRig(object: number): PuppetRig | null {
    const layer = this.findLayer(object);
    const rig = layer ? puppetEntries([layer])[0]?.puppet : undefined;
    return rig?.skeleton ? rig : null;
  }

  /**
   * 对象的动画层视图（P12c）：宿主给的优先；没有时（语料诊断、`realmCheck`）按 bundle 的层定义现造，名字、只读三项照算，方法空操作。
   */
  private puppetView(object: number): PuppetLayersView {
    const hosted = this.access.puppetLayers?.(object);
    if (hosted) return hosted;
    // 替身按编译期层的 id（= `entry`，P12e）
    const defs = () => this.puppetRig(object)?.layers ?? [];
    return {
      ids: () => defs().map((def) => def.entry),
      find: (name) => {
        if (name === "") return null;
        const list = defs();
        for (let index = list.length - 1; index >= 0; index--)
          if (this.fallbackControl(object, list[index].entry)?.name === name) return list[index].entry;
        return null;
      },
      control: (id) => this.fallbackControl(object, id),
      alive: (id) => defs().some((def) => def.entry === id),
    };
  }

  /** 没有宿主视图时的控制口替身：值取自层定义（按层 id），名字与四个可写项存在替身上，方法空操作。 */
  private fallbackControl(object: number, id: number): PuppetLayerControl | null {
    const key = `${object}:${id}`;
    const cached = this.fallbackLayerControls.get(key);
    if (cached) return cached;
    const rig = this.puppetRig(object);
    const def = rig?.layers.find((item) => item.entry === id);
    const animation = def ? rig!.animations[def.animation] : undefined;
    if (!def || !animation) return null;
    const fps = Math.fround(animation.fps);
    const frames = Math.trunc(animation.length);
    const control: PuppetLayerControl = {
      fps: fps > 0 ? fps : 1,
      frameCount: frames,
      duration: fps > 0 ? Math.fround(Math.fround(frames) / fps) : 0,
      name: def.name,
      additive: def.additive,
      blendin: def.blendin,
      blendout: def.blendout,
      blendtime: def.blendtime,
      play: () => {},
      pause: () => {},
      stop: () => {},
      isPlaying: () => false,
      setFrame: () => {},
      getFrame: () => 0,
      addEndedCallback: () => {},
    };
    this.fallbackLayerControls.set(key, control);
    return control;
  }

  /**
   * 图像层上的骨骼方法（P12d-2，rea-p12d-bones；模型对象、声音 / 粒子 / 文本层没有，`alignment` 有值即图像层）：
   * - `getBoneCount()`：mdl 骨骼数（静态 puppet 也有），非 puppet 为 0；
   * - `getBoneTransform(bone)`：每次新建 `Mat4`，选骨失败（越界、非整数、空串、没推进过、静态 puppet）返回单位阵、不返回 `null`；
   * - `setBoneTransform(bone, mat)`：`mat` 不是对象 / 没有数组 `m` 时当单位阵，`m` 里不是数的元素取单位阵对应位的值（dll 的 Mat4 实参转换）；
   * - `applyBonePhysicsImpulse(bone, dir, ang?)`：`dir` / `ang` 读 `x y z`，不是对象（含缺省）当 `(0, 0, 0)`，不抛错；
   * - `resetBonePhysicsSimulation(bone)`。
   * `bone` 先按 dll 的规则规整：Int32 数 → 下标，字符串 → 名字，其余（`1.5`、对象、缺省）→ 空串。
   */
  private installBones(api: ApiObject, object: number): void {
    const bone = (value: unknown): number | string =>
      typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        ? value
        : typeof value === "string"
          ? value
          : "";
    const view = () => this.access.puppetLayers?.(object) ?? null;
    this.method(api, "getBoneCount", () => {
      const puppet = this.findLayer(object)?.puppet;
      return puppet ? (puppet.boneCount ?? puppet.skeleton?.parents.length ?? 0) : 0;
    });
    this.method(api, "getBoneTransform", (b?: unknown) => {
      const m = view()?.boneTransform?.(bone(b)) ?? IDENTITY_4;
      const mat = (this.realm.global.Object as typeof Object).create(this.realm.prototypes.Mat4) as ApiObject;
      mat.m = this.array(Array.from(m));
      return mat;
    });
    this.method(api, "setBoneTransform", (b?: unknown, mat?: unknown) => {
      const m = Array.from(IDENTITY_4);
      const source = mat !== null && typeof mat === "object" ? (mat as ApiObject).m : undefined;
      if (Array.isArray(source))
        for (let i = 0; i < 16; i++) if (typeof source[i] === "number") m[i] = Math.fround(source[i] as number);
      view()?.setBoneTransform?.(bone(b), m);
      return undefined;
    });
    this.method(api, "applyBonePhysicsImpulse", (b?: unknown, dir?: unknown, ang?: unknown) => {
      view()?.applyBonePhysicsImpulse?.(bone(b), vec3Arg(dir, [0, 0, 0]), vec3Arg(ang, [0, 0, 0]));
      return undefined;
    });
    this.method(api, "resetBonePhysicsSimulation", (b?: unknown) => {
      view()?.resetBonePhysicsSimulation?.(bone(b));
      return undefined;
    });
  }

  /**
   * 图层对象上的动画层入口（P12c，rea-p12c-script 1，p12-REPORT 用例 9）：所有图层都装，不是 puppet 的计数 0、查找返回 `null`。
   * `getAnimationLayer(x)` 按 x 的类型：number 只认 `0 ≤ x < count` 的整数（`1.5`、`-1` 为 null）；非空字符串按当前名字找、最后一个匹配
   * （`"1"` 也是按名字）；其余（空串、无参、对象）为 null。
   */
  private installAnimationLayers(api: ApiObject, object: number): void {
    this.method(api, "getAnimationLayerCount", () => this.puppetView(object).ids().length);
    this.method(api, "getAnimationLayer", (x?: unknown) => {
      const view = this.puppetView(object);
      let id: number | null = null;
      if (typeof x === "number") {
        const ids = view.ids();
        if (Number.isInteger(x) && x >= 0 && x < ids.length) id = ids[x];
      } else if (typeof x === "string" && x !== "") id = view.find(x);
      return id === null ? null : this.animationLayerApi(object, id);
    });
    // 运行时建删层（P12e，rea-p12e）：不是带骨骼的运行时（非 puppet、静态 puppet、没有宿主视图）建层 `null`、删层 `false`
    this.method(api, "createAnimationLayer", (first?: unknown, config?: unknown) =>
      this.createAnimationLayer(object, first, config, false),
    );
    this.method(api, "playSingleAnimation", (first?: unknown, config?: unknown) =>
      this.createAnimationLayer(object, first, config, true),
    );
    // dll 形参 0xa08：字符串 → 名字（空串 false）；Int32（整数、在 int32 范围、不是 −0）→ 层表下标；有效的动画层包装 → 它的 id（别的对象的层 false：
    // WPE 按指针在本层表里找不到；层 id 是每个 puppet 各自的，不能把别人的 id 传给本层表）；其余（1.5、{}、作废的包装、null、缺参数）→ false
    this.method(api, "destroyAnimationLayer", (x?: unknown) => {
      let selector: { name: string } | { index: number } | { id: number };
      if (typeof x === "string") {
        const end = x.indexOf("\0");
        const name = end < 0 ? x : x.slice(0, end);
        if (name === "") return false;
        selector = { name };
      } else if (typeof x === "number") {
        if (!Number.isInteger(x) || Object.is(x, -0) || x < -2147483648 || x > 2147483647) return false;
        selector = { index: x };
      } else if (typeof x === "object" && x !== null) {
        const layer = this.animationLayerOf.get(x as ApiObject);
        if (!layer || layer.object !== object || this.dead(x as ApiObject)) return false;
        selector = { id: layer.id };
      } else return false;
      return this.puppetView(object).destroy?.(selector) ?? false;
    });
  }

  /**
   * `createAnimationLayer` / `playSingleAnimation`（P12e）：参数规整见 `animationLayerItem`；规整出 `null`、没有建层入口、运行时拒绝（动画带
   * `unsupported`）都返回 `null`。建出来写进状态里三方共写字段（rate / blend / visible）的起始值，返回包装（与之后 `getAnimationLayer(count − 1)` 同一个对象）。
   * 静态 puppet（WPE 建出一个永不推进的层、计数加一，语料 0）返回 `null` 并 warn（有意不同）。
   */
  private createAnimationLayer(object: number, first: unknown, config: unknown, single: boolean): ApiObject | null {
    const puppet = this.findLayer(object)?.puppet;
    if (puppet && !puppet.skeleton) {
      this.log(`createAnimationLayer：图层 ${object} 是静态 puppet（没有骨骼），不建层`);
      return null;
    }
    const view = this.puppetView(object);
    if (!view.create || !view.animations) return null;
    const json = this.realm.global.JSON as RealmJson;
    const { item, warn } = animationLayerItem(first, config, view.animations(), json);
    if (warn) this.log(warn);
    if (!item) return null;
    const id = view.create(item, single);
    if (id === null) return null;
    this.access.state().addAnimationLayer(object, id, { rate: item.rate, blend: item.blend, visible: item.visible });
    return this.animationLayerApi(object, id);
  }

  private log(message: string): void {
    if (this.access.warn) this.access.warn(message);
    else console.warn(message);
  }

  /**
   * `IAnimationLayer` 包装对象（P12c，p12-REPORT 用例 9、rea-p12c-script 5）：按 `<对象>:<层 id>` 缓存（P12e：id 不是层表下标，编译期层 = `animationlayers` 的
   * JSON 下标、运行时建的层是负数），不持有运行时，每次经 `puppetView` 现取控制口（重编译换了 `ScenePuppets` 也接得上）。层被释放后包装作废（`dead`）。
   * 19 个自有可枚举成员，顺序照实测：
   * - `duration` / `frameCount` / `fps`：访问器（作废后读 `undefined`），值在建对象时取，赋值抛和 WPE 日志同一句的 TypeError；
   * - `rate` / `blend` / `visible`：访问器，读写 `SceneState.animationLayers`（用户属性、字段脚本、API 三方共写的字段，写走 `animation-layer` 目标，
   *   下一帧生效）；`rate` / `blend` 只收 number（`NaN`、`Infinity` 也收，转 float32，不钳制），`visible` 只收布尔，别的静默忽略；
   * - `name` / `additive` / `blendin` / `blendout` / `blendtime`：访问器，读写控制口；`name` 忽略 `null` / `undefined`、其余 `ToString`（在第一个
   *   NUL 处截断，WPE 的 setter 用 `strlen`），三个布尔只收布尔，`blendtime` 只收 number；
   * - 方法是数据属性；`setFrame(x)` 的 x 不是 number 时按 0；`addEndedCallback(fn)` 非函数抛 `TypeError`（WPE 会存空指针、播完时崩溃，有意不同），
   *   登记的回调经运行时 `callFor` 进入登记它的那段脚本、`this` 是它的模块命名空间、不带参数；
   * - `getAnimation`：对象上通用的那个，属主路径 `objects/<i>/animationlayers/<entry>`（语料下总是 `undefined`）。
   * 原型照 WPE：只有一个不可枚举 `constructor` 的自有原型（`IAnimation` 那边仍是普通原型，已知差异）。
   */
  private animationLayerApi(object: number, id: number): ApiObject | null {
    const key = `${object}:${id}`;
    const cached = this.animationLayerApis.get(key);
    if (cached) return cached;
    const first = this.puppetView(object).control(id);
    if (!first) return null;
    const Obj = this.realm.global.Object as typeof Object;
    // 原型照 WPE（实测 `Object.getOwnPropertyNames(Object.getPrototypeOf(layer))` 只有 `constructor`）：自己的原型，只有一个不可枚举的 `constructor`，再往上是 Object.prototype
    const proto = Obj.create(Obj.prototype, {
      constructor: {
        value: new (this.realm.global.Function as FunctionConstructor)("return function IAnimationLayer() {}")(),
        writable: true,
        configurable: true,
        enumerable: false,
      },
    });
    const api = Obj.create(proto) as ApiObject;
    const control = () => this.puppetView(object).control(id);
    const def = () => this.puppetRig(object)?.layers.find((item) => item.entry === id);
    const fields = () => this.access.state().animationLayers.get(animationLayerKey(object, id));
    // 只读三项（P12e）：作废后和其余成员一样读 `undefined`，所以是访问器；但不能是「只有 getter」——WPE 的日志（p12-script 第 19 行）是
    // `Cannot assign to read only property 'fps' of object '[object Object]'`（数据属性的报错），getter-only 的报错是另一句。
    // setter 抛同一句 TypeError（脚本都是严格模式的模块，赋值本来就抛）；作废后赋值照 `define` 的守卫忽略
    const constant = (name: string, value: unknown) =>
      this.define(
        api,
        name,
        () => value,
        () => {
          throw new TypeError(`Cannot assign to read only property '${name}' of object '[object Object]'`);
        },
      );
    // 方法仍是数据属性（成员顺序与描述符同 P12c），值包一层作废守卫：层被释放后调用直接返回 `undefined`、不抛错（含 `addEndedCallback(非函数)`）
    const method = (name: string, run: (...args: unknown[]) => unknown) =>
      Obj.defineProperty(api, name, {
        value: (...args: unknown[]) => (this.dead(api) ? undefined : run(...args)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    this.animationLayerOf.set(api, { object, id });
    // rate / blend / visible：状态里的字段（读取时没有状态项就取编译期的值）
    const stateField = (name: "rate" | "blend" | "visible") => {
      const target = (): ApiTarget => ({ kind: "animation-layer", object, layer: id, field: name });
      this.define(
        api,
        name,
        () => {
          const value = fields()?.[name] ?? def()?.[name] ?? (name === "visible" ? true : 1);
          return typeof value === "number" ? Math.fround(value) : value;
        },
        (value) => {
          if (name === "visible") {
            if (typeof value === "boolean") this.write(target(), value, "bool");
          } else if (typeof value === "number") this.write(target(), value, "float");
        },
      );
    };
    // 控制口上的三个布尔项
    const controlBoolean = (name: "additive" | "blendin" | "blendout") =>
      this.define(
        api,
        name,
        () => control()?.[name] ?? false,
        (value) => {
          const c = control();
          if (c && typeof value === "boolean") c[name] = value;
        },
      );
    constant("duration", first.duration);
    constant("frameCount", first.frameCount);
    constant("fps", first.fps);
    stateField("blend");
    this.define(
      api,
      "name",
      () => control()?.name ?? "",
      (value) => {
        const c = control();
        const text = scriptToString(value);
        if (!c || text === undefined) return;
        const end = text.indexOf("\0");
        c.name = end < 0 ? text : text.slice(0, end);
      },
    );
    controlBoolean("blendout");
    controlBoolean("blendin");
    stateField("rate");
    controlBoolean("additive");
    stateField("visible");
    this.define(
      api,
      "blendtime",
      () => control()?.blendtime ?? 0,
      (value) => {
        const c = control();
        if (c && typeof value === "number") c.blendtime = Math.fround(value);
      },
    );
    method("addEndedCallback", (callback) => {
      if (typeof callback !== "function") throw new TypeError("addEndedCallback 需要回调函数");
      // 登记时取当前脚本；没有控制口（运行时还没建）或没有当前脚本时没有东西会播完，不登记
      const owner = this.current?.id;
      const c = control();
      if (!c || owner === undefined) return;
      c.addEndedCallback(() =>
        this.runtime?.callFor(owner, (exports) => (callback as (this: unknown) => unknown).call(exports)),
      );
    });
    method("play", () => void control()?.play());
    method("isPlaying", () => control()?.isPlaying() ?? false);
    method("stop", () => void control()?.stop());
    method("pause", () => void control()?.pause());
    method("setFrame", (frame) => void control()?.setFrame(typeof frame === "number" ? frame : 0));
    method("getFrame", () => control()?.getFrame() ?? 0);
    this.installGetAnimation(api, () => `objects/${object}/animationlayers/${id}`);
    this.animationLayerApis.set(key, api);
    return api;
  }

  private installScene(): void {
    this.installLayerTable();
    // 全场景按名字找第一条（P10b，步骤 0 Q6）：参数不是字符串、找不到都是 null；空串照常查（取第一条没写 name 的）
    this.method(this.thisScene, "getAnimation", (name: unknown) => {
      this.requireAnimationContext();
      if (typeof name !== "string") return null;
      const def = this.findAnimation(null, name);
      return def ? this.animationApi(def) : null;
    });
    this.installCameraTransforms();
  }

  /**
   * 相机基准（P5e，p5e 步骤 0 实测）：`getCameraTransforms()` 每次返回新的普通对象（键序 eye、center、up、zoom；前三个是新的 `Vec3`，zoom 是
   * number），读的是基准当前值（`SceneState.cameraBase`，含本帧之前 set 过的），不是路径、抖动、相机对象的结果；`setCameraTransforms(t)` 没有参数或
   * `t` 不是对象返回 false、什么都不改，否则四项各自处理：eye / center / up 是对象就取 x / y / z（是 number 转 float32、不是记 0），zoom 是 number
   * 才转 float32，别的项跳过，返回 true。两个都不能在模块顶层调用。
   */
  private installCameraTransforms(): void {
    const isObject = (value: unknown): value is Record<string, unknown> =>
      (typeof value === "object" && value !== null) || typeof value === "function";
    this.sceneMethod("getCameraTransforms", () => {
      const base = this.access.state().cameraBase;
      const result = this.object();
      result.eye = this.vector(base.eye, 3);
      result.center = this.vector(base.center, 3);
      result.up = this.vector(base.up, 3);
      result.zoom = base.zoom;
      return result;
    });
    this.sceneMethod("setCameraTransforms", (...args) => {
      const transforms = args[0];
      if (args.length < 1 || !isObject(transforms)) return false;
      // 先把四项都读出来（WPE 按 eye、center、up、zoom 的顺序各取一次属性），再写
      const fields = [transforms.eye, transforms.center, transforms.up, transforms.zoom];
      const toFloat = (value: unknown): number => (typeof value === "number" ? Math.fround(value) : 0);
      (["eye", "center", "up"] as const).forEach((field, i) => {
        const vector = fields[i];
        if (isObject(vector))
          this.access.write({ kind: "camera-base", field }, [toFloat(vector.x), toFloat(vector.y), toFloat(vector.z)]);
      });
      if (typeof fields[3] === "number")
        this.access.write({ kind: "camera-base", field: "zoom" }, [Math.fround(fields[3])]);
      return true;
    });
  }

  /** C `strtol` 十进制：前导空白（`isspace`，不是 JS 的 `\s`）、可带 ±、取到第一个非数字为止，没有数字得 0。 */
  private strtol(text: string): number {
    const match = /^[ \t\n\v\f\r]*([+-]?)(\d*)/.exec(text)!;
    return match[2] ? Number(match[1] + match[2]) : 0;
  }

  /**
   * 图层参数的解析（P6d3a，WPE dll 的 `R`，rea-p6d-script 4.1）：返回 `order` 里的对象与它是否待删。
   * - 字符串：先按名字取 `order` 里**第一个**同名对象（它待删时按 `rejectPendingName` 返回 null、不再往后找）；没有同名再按 `strtol` 当 id 找；
   * - 数字：`ToInt32`，按 `order` 的原始下标取，越界 null；
   * - 图层对象（本 API 建的）：取它的下标，**不看待删**（dll 的对象分支直接取指针，0c 实测同帧用对象再删一次仍是 true）；作废的当作找不到；
   * - 其它都是 null。
   * 数字与 id 命中的待删对象按 `rejectPending` 返回 null 或照常返回。
   */
  private lookup(
    value: unknown,
    rejectPending: boolean,
    rejectPendingName: boolean,
  ): { object: number; pending: boolean } | null {
    const state = this.access.state();
    const order = state.order;
    const hit = (object: number, reject: boolean) => {
      const pending = state.pendingDestroy.has(object);
      return pending && reject ? null : { object, pending };
    };
    if (typeof value === "string") {
      for (const object of order) if (this.nameOf(object) === value) return hit(object, rejectPendingName);
      const id = this.strtol(value);
      for (const object of order) if (this.idOf(object) === id) return hit(object, rejectPending);
      return null;
    }
    if (typeof value === "number") {
      const index = value | 0;
      if (index < 0 || index >= order.length) return null;
      return hit(order[index], rejectPending);
    }
    if (value !== null && typeof value === "object") {
      for (const [object, api] of this.layers)
        if (api === value) return this.alive(object) && order.includes(object) ? hit(object, false) : null;
    }
    return null;
  }

  /** `R`：数字、名字、id 命中待删对象时解析不到（null）；图层对象照常解析（见 `lookup`）。 */
  private resolveLayer(value: unknown): number | null {
    return this.lookup(value, true, true)?.object ?? null;
  }

  /** thisScene 方法在模块顶层调用抛 realm 的 `SyntaxError`；`messageName` 是 dll 里抄错的名字（`getLayerByID` 用 `getLayer`）。 */
  private sceneMethod(name: string, fn: (...args: unknown[]) => unknown, messageName = name): void {
    this.method(this.thisScene, name, (...args: unknown[]) => {
      if (this.evaluating) throw this.syntaxError(`${messageName} cannot be called from global scope.`);
      return fn(...args);
    });
  }

  /**
   * 下标与结构 API（P6d3a，rea-p6d-layers 3.3、rea-p6d-script 5.1）：读写 `SceneState.order`（WPE 的对象表 `G+0x158`）。
   * 都不能在模块顶层调用。`getLayerIndex` 与 `getInitialLayerConfig` 不看待删（照 dll 的 `H+0x48`）。
   */
  private installLayerTable(): void {
    const state = () => this.access.state();
    this.installCreateLayer();
    // 不传参数返回 undefined（0c 实测）；传了 undefined 的行为不变（按名字找、找不到 null）。数字、名字、图层对象都按 `R`
    this.sceneMethod("getLayer", (...args) => {
      if (args.length === 0) return undefined;
      const object = this.resolveLayer(args[0]);
      return object === null ? null : this.layer(object);
    });
    // 只收字符串（P6d0c 实测：数字全是 null，无参 undefined），照 C `strtol` 解析；待删的返回 null
    this.sceneMethod(
      "getLayerByID",
      (...args) => {
        if (args.length === 0) return undefined; // 只区分没传参数（传了 undefined 当非字符串，得 null）
        const id = args[0];
        if (typeof id !== "string") return null;
        const value = this.strtol(id);
        const layer = this.access.bundle().layers.find((item) => item.id === value);
        // 没有编译产物的待编对象（以及编进 bundle 后 id 被重新发过的）按建出时发的 id 找（P6d3b）
        const object = layer?.object ?? this.createdIds.get(value);
        if (object === undefined || !this.alive(object) || state().pendingDestroy.has(object)) return null;
        return this.layer(object);
      },
      "getLayer",
    );
    this.sceneMethod("getLayerCount", () => state().order.length - state().pendingDestroy.size);
    this.sceneMethod("enumerateLayers", () =>
      this.array(
        state()
          .order.filter((object) => !state().pendingDestroy.has(object))
          .map((object) => this.layer(object)),
      ),
    );
    // 返回 `order` 里的原始下标（含待删），找不到 −1；参数不是对象 / 数字 / 字符串也是 −1
    this.sceneMethod("getLayerIndex", (value) => {
      if (typeof value !== "object" && typeof value !== "number" && typeof value !== "string") return -1;
      const hit = this.lookup(value, false, false);
      return hit ? state().order.indexOf(hit.object) : -1;
    });
    // 少于两个参数、第一参不是对象 / 数字 / 字符串、第二参不是 Number（`'3'` 也是）都是 false；其余按 `R` 解析后改表
    this.sceneMethod("sortLayer", (...args) => {
      if (args.length < 2) return false;
      const first = args[0];
      if (typeof first !== "object" && typeof first !== "number" && typeof first !== "string") return false;
      if (typeof args[1] !== "number") return false;
      const object = this.resolveLayer(first);
      return object === null ? false : state().sortLayer(object, args[1] | 0);
    });
    // 解析不到（含 `null`、待删）返回 false；否则记待删（生效在脚本阶段之后）
    this.sceneMethod("destroyLayer", (...args) => {
      if (args.length === 0) return false;
      const object = this.resolveLayer(args[0]);
      return object === null ? false : state().markDestroy(object);
    });
    // 加载时的配置原文（`bundle.configs`，去掉 id、键按字典序、浮点 8 位有效数字）：每次在 realm 里新解析一份；解析不到、没有配置返回 null。
    // 名字解析里第一个同名对象待删时仍是 null（`R`），别的路径不看待删
    this.sceneMethod(
      "getInitialLayerConfig",
      (...args) => {
        const hit = this.lookup(args[0], false, true);
        const pending = hit ? this.pending.get(hit.object) : undefined;
        const text = hit
          ? (this.access.bundle().configs?.[hit.object] ?? (pending ? normalizeConfig(pending.config) : null))
          : null;
        return text ? (this.realm.global.JSON as JSON).parse(text) : null;
      },
      "destroyLayer",
    );
  }

  /**
   * 命中片段缓存时交给运行时的脚本条目（L5）：用 bundle 里这个对象的定型条目（材质常量目标已补 uniforms、动画层字段脚本已过滤，同没命中时片段到达后
   * `refreshScripts` 换上的），只有 `scriptProperties` 取按当前属性收集的那份（缓存里的片段是按编它那一刻的属性编的，`init` 要拿当前值）。
   */
  private compiledScripts(object: number, collected: readonly SceneScript[]): SceneScript[] {
    const current = new Map(collected.map((script) => [script.id, script.scriptProperties] as const));
    const prefix = `objects/${object}/`;
    return this.access
      .bundle()
      .scripts.list.filter((script) => script.id.startsWith(prefix))
      .map((script) => (current.has(script.id) ? { ...script, scriptProperties: current.get(script.id)! } : script));
  }

  /** 图层名（脚本写过的优先，否则已编译的取 `SceneLayer`、待编对象取建出时的）；没有对象是 undefined。 */
  private nameOf(object: number): string | undefined {
    return this.layerNames.get(object) ?? this.findLayer(object)?.name ?? this.pending.get(object)?.name;
  }
  /** 图层 id（同 `nameOf`）。 */
  private idOf(object: number): number | undefined {
    return this.findLayer(object)?.id ?? this.pending.get(object)?.id;
  }

  /**
   * 新 bundle 换上后（宿主 `beforeFirstFrame`，P6d3b）：已经有编译产物的待编对象不再待编（名字、id、类别以后看 `SceneLayer`）。
   * `createdIds` 保留，建出时发的 id 仍能 `getLayerByID`。
   */
  adoptBundle(): void {
    for (const object of [...this.pending.keys()]) if (this.findLayer(object)) this.pending.delete(object);
    this.seedLayerIds();
  }

  /** 新图层 id 的下界按当前 bundle 抬高（L4，见 `nextLayerId`）。 */
  private seedLayerIds(): void {
    const bundle = this.access.bundle();
    let max = 0;
    for (const layer of bundle.layers) max = Math.max(max, layer.id);
    for (const id of this.createdIds.keys()) max = Math.max(max, id);
    for (const item of this.pending.values()) max = Math.max(max, item.id);
    this.nextLayerId = Math.max(this.nextLayerId, max + 1);
    this.layerIdBundle = bundle;
  }

  /** 当前存在的对象里按 JSON `id` 找（编译的图层，再按 `createdIds` 找建出的对象，含待编的；待删与已删的不算）；找不到 null。 */
  private objectById(id: number): number | null {
    const state = this.access.state();
    const alive = (object: number) => state.layers.has(object) && !state.pendingDestroy.has(object);
    for (const layer of this.access.bundle().layers) if (layer.id === id && alive(layer.object)) return layer.object;
    const created = this.createdIds.get(id);
    return created !== undefined && alive(created) ? created : null;
  }

  /**
   * 配置里有非 0 的数字 `id` 照用（不查重）；否则取「全部图层与已建对象的 id 最大值 + 1」与单调下界（`nextLayerId`，L4）的较大者起第一个没被占的，
   * 发出后下界移到它之后。WPE 是渲染器级计数器，值复刻不了；只保证不回落、不重发。
   */
  private newLayerId(config: Record<string, unknown> | unknown[]): number {
    const own = Array.isArray(config) ? 0 : config.id;
    if (typeof own === "number" && own !== 0) return own;
    if (this.access.bundle() !== this.layerIdBundle) this.seedLayerIds();
    const used = new Set<number>(this.createdIds.keys());
    for (const layer of this.access.bundle().layers) used.add(layer.id);
    for (const item of this.pending.values()) used.add(item.id);
    let id = Math.max(Math.max(0, ...used) + 1, this.nextLayerId);
    while (used.has(id)) id++;
    this.nextLayerId = id + 1;
    return id;
  }

  /**
   * `thisScene.createLayer(...args)`（P6d3b，rea-p6d-script 1.2、1.3，rea-p6d-layers 3–5）：参数整理成配置（`createLayerConfig`）→ 宿主分配下标、建待编
   * 对象 → 配置里带的脚本当场实例化并跑完 `init` → 返回新图层对象。整个过程同步，返回时 `before` → 新层各段 `init` → `after` 的顺序与 WPE 一致。
   * 不能在模块顶层调用（`SyntaxError`）；整理不出配置（`Vec3` 等）返回 null。
   */
  private installCreateLayer(): void {
    this.sceneMethod("createLayer", (...args) => {
      const create = this.access.createLayer;
      if (!create) return null;
      const bundle = this.access.bundle();
      const assets = new Set(bundle.assetPaths ?? []);
      const internal = this.realm.internal;
      const context: CreateConfigContext = {
        // 读调用那一刻的 `_Internal.stringifyConfig`（脚本可以改写它，rea-p6d-script 5.5），`this` 是 `_Internal`
        stringify: (value) =>
          typeof internal.stringifyConfig === "function"
            ? internal.stringifyConfig.call(internal, value)
            : JSON.stringify(value),
        orthographic: !bundle.general.perspective,
        workshopId: this.access.workshopId?.() ?? null,
        inAssets: (path) => assets.has(path),
      };
      const config = createLayerConfig(args, context);
      if (config === null) return null;
      // id 先定、写进结构里的配置原文：编译按它发 `SceneLayer.id`（缺省会取图层个数，和已有的撞号），重编译前后按 id 找到的是同一个；
      // `getInitialLayerConfig` 的规整去掉顶层 `id`，读不到它。数组配置没处写，编成分组节点后按编译的规则发
      const id = this.newLayerId(config);
      const text = JSON.stringify(Array.isArray(config) ? config : { ...config, id });
      const parentId = Array.isArray(config) ? undefined : config.parent;
      const parent = typeof parentId === "number" ? this.objectById(parentId) : null;
      const object = create.call(this.access, text, parent);
      if (object === null) return null;
      // 命中片段缓存（L5）：宿主在 `create` 里已经把编好的对象接进了 bundle，不是待编对象
      const compiled = this.findLayer(object) !== undefined;
      if (!compiled) {
        const shell = layerShellValues((Array.isArray(config) ? {} : config) as SceneObject);
        this.pending.set(object, { name: shell.name, id, kind: createdLayerKind(config), config });
      }
      this.createdIds.set(id, object);
      if (!Array.isArray(config)) {
        const properties: Record<string, SceneScalar> = Object.fromEntries(
          [...this.properties].map(([key, property]) => [key, property.value as SceneScalar]),
        );
        const collected = collectObjectScriptsSync(config, object, properties);
        const scripts = compiled ? this.compiledScripts(object, collected) : collected;
        if (scripts.length) this.access.addScripts?.(scripts);
      }
      return this.layer(object);
    });
  }

  /** 对象当前的挂点名：运行中换过父的取结构里最后一条，否则取编译期的（对象 JSON 的 `attachment`，只在 bundle 里解析成功时算）。 */
  private currentBone(object: number): string | null {
    const entries = this.access.structure?.().parents ?? [];
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i][0] === object) return entries[i][2];
    if (!this.findLayer(object)?.attachment) return null;
    try {
      const config = JSON.parse(this.access.bundle().configs?.[object] ?? "null") as { attachment?: unknown } | null;
      return typeof config?.attachment === "string" ? config.attachment : null;
    } catch {
      return null;
    }
  }

  /** 父图层 puppet（或带骨骼的模型）的挂点表；没有时空数组。 */
  private attachmentsOf(parent: number | null): readonly { name: string }[] {
    if (parent === null) return [];
    const layer = this.findLayer(parent);
    return layer?.puppet?.attachments ?? layer?.model?.skeleton?.attachments ?? [];
  }

  /** 组（模型 JSON `passthrough: true` 的图像层，不看有没有子层）。 */
  private isGroup(object: number): boolean {
    return this.findLayer(object)?.passthroughModel === true;
  }

  /**
   * `setParent(parent, attachment | adjust, adjust)`（P6d3a，rea-p6d-layers 9.4、rea-p6d3-adjust、步骤 0 实测）：
   * 1. 第一参按 `R` 解析（对象 / 名字 / 下标）；解析不到（`undefined`、找不到、待删、作废）当解除父子；
   * 2. `adjust` = 第二参或第三参 `=== true`；第二参是整数或字符串时当挂点（整数按新父的挂点表取名，字符串按名，取不到当没有挂点）；
   * 3. 父与挂点都没变直接返回（在一切检查之前）；
   * 4. 成环（新父是自己或自己的子孙）不改、记 warn、返回（WPE 没有检测、整个进程崩溃）；
   * 5. 先从旧父摘掉，再做组深度检查（`up(新父) + down(自己) ≥ 4` 失败：父置空、本地字段不动、抛 `Error("Invalid parent configuration.")`）；
   * 6. adjust 为假只换父；adjust 为真照 `adjustReparent` 重算 origin / angles / scale，带挂点时 origin 与 angles 归零（缩放不变）。
   */
  private setParent(object: number, args: unknown[]): undefined {
    const state = this.access.state();
    const self = state.layers.get(object);
    if (!self) return undefined;
    const target = this.resolveLayer(args[0]);
    // 父走 exe 侧的 `D[3]`（rea-p6d-layers 1 节）：对象也要在表里且不待删，这一点和 dll 的 `R` 不同
    const parent = target !== null && state.layers.has(target) && !state.pendingDestroy.has(target) ? target : null;
    const adjust = args[1] === true || args[2] === true;
    const second = args[1];
    const tables = this.attachmentsOf(parent);
    let bone: string | null = null;
    if (parent !== null) {
      if (typeof second === "string") bone = tables.some((item) => item.name === second) ? second : null;
      else if (typeof second === "number" && Number.isInteger(second)) bone = tables[second]?.name ?? null;
    }
    const oldParent = self.parent;
    const oldBone = this.currentBone(object);
    if (parent === oldParent && bone === oldBone) return undefined;
    // 成环：新父是自己或自己的子孙
    if (parent !== null && state.subtree(object).includes(parent)) {
      const message = `setParent：图层 ${object} 不能挂到自己或自己的子孙下，已忽略`;
      if (this.access.warn) this.access.warn(message);
      else console.warn(message);
      return undefined;
    }
    // 组深度（`FUN_1401ddb50`）：up 从新父沿父链数组、down 是自己这棵子树里最深的组嵌套
    let up = 0;
    const seen = new Set<number>();
    for (
      let current = parent;
      current !== null && !seen.has(current);
      current = state.layers.get(current)?.parent ?? null
    ) {
      seen.add(current);
      if (this.isGroup(current)) up++;
    }
    const down = (current: number, guard: Set<number>): number => {
      if (guard.has(current)) return 0;
      guard.add(current);
      let deepest = 0;
      for (const child of state.childrenOf(current)) deepest = Math.max(deepest, down(child, guard));
      return (this.isGroup(current) ? 1 : 0) + deepest;
    };
    const depth = up + down(object, new Set());
    // adjust 的数学读换父之前的状态（旧父、旧本地字段）：先算，之后才改结构
    const adjusted =
      adjust && bone === null && depth < 4
        ? adjustReparent(object, parent, state.layers, this.access.attachPose)
        : null;
    // 先从旧父摘掉（失败时它已经离开了）
    if (self.parent !== null) state.setParent(object, null);
    if (depth >= 4) {
      this.access.reparented?.({ object, oldParent, oldBone, parent: null, bone: null });
      const ErrorCtor = (this.realm.global.Error as ErrorConstructor | undefined) ?? Error;
      throw new ErrorCtor("Invalid parent configuration.");
    }
    if (adjust) {
      if (adjusted) {
        this.access.write({ kind: "layer", object, field: "origin" }, adjusted.origin);
        this.access.write({ kind: "rotation", object, rotation: null, angles: adjusted.angles }, adjusted.angles);
        this.access.write({ kind: "layer", object, field: "scale" }, adjusted.scale);
      } else if (bone !== null) {
        this.access.write({ kind: "layer", object, field: "origin" }, [0, 0, 0]);
        this.access.write({ kind: "rotation", object, rotation: null, angles: [0, 0, 0] }, [0, 0, 0]);
      }
    }
    state.setParent(object, parent);
    this.access.reparented?.({ object, oldParent, oldBone, parent, bone });
    return undefined;
  }

  /** bundle 里某个 pass（基础材质或 effect 绘制 pass），按稳定键找。 */
  private findPass(pass: string): ScenePass | undefined {
    for (const layer of this.access.bundle().layers) {
      for (const item of layer.passes) if (item.key === pass) return item;
      for (const effect of layer.effects)
        for (const step of effect.steps) if (step.kind === "draw" && step.pass.key === pass) return step.pass;
    }
    return undefined;
  }

  /**
   * 一个 pass 的材质对象上登记的常量键（P6d1a）：只收编译后着色器实际读到的键（`slot.used`，p6d1-mat3 实测：chromaticaberration 缺省
   * `MODE 0` 不用方向键，材质对象里就没有它）；Map 顺序是声明顺序、不影响别处；材质对象上的键顺序由 `materialKeyOrder.ts` 定（照 WPE 的 MSVC `unordered_map` 迭代顺序）。
   * `rad2deg`：脚本里这个键用度、状态里存弧度。
   */
  private materialConstants(pass: string): Map<string, MaterialConstant> {
    const names = new Map<string, MaterialConstant>();
    const bundle = this.access.bundle();
    const current = this.findPass(pass);
    const program =
      current?.program === null || current?.program === undefined ? null : bundle.programs[current.program];
    // 每个材质键一个字段：形状取这个键 setter 的类型，写回按各格的取值方式（`materialValues.ts`）
    for (const slot of materialSlots(program?.uniforms ?? []))
      if (slot.material && slot.used)
        names.set(slot.material, { shape: constantTargetFields(slot), rad2deg: slot.rad2deg });
    // FakeRealm 单测没有翻译器结果；真实 bundle 以 meta.material 为准。
    if (!program)
      for (const script of bundle.scripts.list)
        if (script.owner.kind === "material" && script.owner.pass === pass && script.target.kind === "constant")
          names.set(script.target.material, {
            shape: { uniforms: script.target.uniforms, type: script.target.type, members: script.target.members },
            rad2deg: false,
          });
    return names;
  }

  private material(pass: string): ApiObject {
    let api = this.materials.get(pass);
    if (api) return api;
    api = this.object();
    const owned = /^objects\/(\d+)\//.exec(pass);
    if (owned) this.ownerOf.set(api, Number(owned[1]));
    const current = this.findPass(pass);
    const constants = this.materialConstants(pass);
    // 五个 pass 状态字段（静态表，rea-p6d1-xform 4.2）：字符串，读到的是当前有效值（脚本写过的覆盖 ?? bundle，`alphawriting` 缺省 default）；
    // 写入走 `pass-state` 目标：规整、记进 `SceneState.passStates`，渲染器下一次同步时换管线（P6d1b）
    const bundled: Record<PassStateField, string> | null = current
      ? {
          depthwrite: current.depthwrite,
          depthtest: current.depthtest,
          cullmode: current.cullmode,
          alphawriting: current.alphaWriting ?? "default",
          blending: current.blending,
        }
      : null;
    // 键顺序照 WPE（`materialKeyOrder.ts`）：常量与状态字段按算出的顺序交错定义；`getAnimation` 在末尾单独装
    for (const name of materialObjectKeys(constants.keys())) {
      if (name === "getAnimation") continue;
      const constant = constants.get(name);
      if (constant) {
        const { shape, rad2deg } = constant;
        this.define(
          api,
          name,
          () => {
            const target: ApiTarget = { kind: "constant", pass, material: name, ...shape };
            const values = this.access.read?.(target) ?? this.access.state().constants.get(pass)?.[shape.uniforms[0]];
            // 带 `rad2deg` 的 float 键读成度（`p6d1-mat4`：chromaticaberration 方向缺省读 90）
            if (rad2deg && Array.isArray(values) && values.length === 1 && typeof values[0] === "number")
              return radiansToScript(values[0]);
            // 同图层字段按 WPE 取单精度（P3b 补测 `ignore/p3b-f32`：`thisObject.alpha` 读出 0.30000001192092896）
            return Array.isArray(values)
              ? values.length === 1
                ? scriptNumber(values[0])
                : this.vector(scriptNumbers(values), values.length as 2 | 3 | 4)
              : values;
          },
          (value) => this.writeConstant(pass, name, shape, rad2deg, value),
        );
      } else if (bundled && isPassStateField(name)) {
        const field = name;
        const target: ApiTarget = { kind: "pass-state", pass, field };
        this.define(
          api,
          name,
          () => this.access.state().passStates.get(pass)?.[field] ?? bundled[field],
          (value) => this.write(target, value, "string"),
        );
      }
    }
    this.installGetAnimation(api, () => `${pass}/constantshadervalues`);
    this.materials.set(pass, api);
    return api;
  }

  /** 材质常量的字段写入：带 `rad2deg` 的 float 键收度（`f32(f32(度) × f32(0.017453292))` 存弧度），别的原样走 `write`。 */
  private writeConstant(
    pass: string,
    material: string,
    shape: MaterialConstant["shape"],
    rad2deg: boolean,
    value: unknown,
  ): void {
    const target: ApiTarget = { kind: "constant", pass, material, ...shape };
    if (rad2deg && shape.type === "float") {
      if (typeof value !== "number") return; // float 只收数（`write` 对别的类型本来也不收）
      value = degreesFromScript(value);
    }
    this.write(target, value, shape.type);
  }

  /**
   * `setMaterialProperty(名, 值)`（`FUN_1401ee1d0` + dll `0x7c` 转换，rea-p6d1-xform 4.1–4.3，`p6d1-round2.log` S1–S7）：值按 dll 归三类
   * （数 → number；任何对象含数组 → Vec2，`x` / `y` 取 `Number()`、非有限数当 0；其余 → 整数 0）。名字不是字符串什么都不做；对 effect 的
   * 每个 pass 按名字全等（区分大小写）找已登记的常量键（状态字段不收），数配 float、Vec2 配 vec2，别的组合跳过；
   * 带 `rad2deg` 的 float 收度。写入走和字段写入同一个 `writeConstant`。
   */
  private setMaterialProperty(object: number, effect: number, name: unknown, value: unknown): void {
    if (typeof name !== "string") return;
    let kind: "number" | "vec2" | "zero";
    let number = 0;
    let vec2 = { x: 0, y: 0 };
    if (typeof value === "number") {
      kind = "number";
      number = value;
    } else if ((typeof value === "object" && value !== null) || typeof value === "function") {
      kind = "vec2";
      const part = (key: string): number => {
        let n: number;
        try {
          n = Number((value as ApiObject)[key]);
        } catch {
          n = NaN;
        }
        return Number.isFinite(n) ? Math.fround(n) : 0;
      };
      vec2 = { x: part("x"), y: part("y") };
    } else {
      kind = "zero"; // 字符串、布尔、`null`、`undefined`：整数 0，float 常量被写成 0
    }
    for (const pass of this.effectPasses(object, effect)) {
      const entry = this.materialConstants(pass.key).get(name);
      if (!entry) continue;
      const { shape, rad2deg } = entry;
      if (shape.type === "float" && kind !== "vec2")
        this.writeConstant(pass.key, name, shape, rad2deg, kind === "number" ? number : 0);
      else if (shape.type === "vec2" && kind === "vec2") this.writeConstant(pass.key, name, shape, rad2deg, vec2);
    }
  }

  /** effect（JSON 下标）的绘制 pass，按 bundle 里的顺序（条件过滤之后，同 WPE `effect+0xd0` 向量）。 */
  private effectPasses(object: number, effect: number): ScenePass[] {
    const item = this.findEffect(object, effect);
    return item ? item.steps.flatMap((step) => (step.kind === "draw" ? [step.pass] : [])) : [];
  }

  private findEffect(object: number, effect: number): SceneEffect | undefined {
    return this.findLayer(object)?.effects.find((item) => item.source === effect);
  }

  private effectName(object: number, effect: number): string {
    return this.effectNames.get(`${object}/${effect}`) ?? this.findEffect(object, effect)?.name ?? "";
  }

  /**
   * 图层的 `getEffectCount()` / `getEffect(i | 名字)`（P6d1a，rea-p6d-layers 10.1，p6d1 0c 实测）：全部 effect（含写死关闭的，
   * 编译期脚本用到 `getEffect` 时都进 bundle）。整数取第 i 个（JSON 下标，越界 / 负数 `null`）；字符串按当前名字**区分大小写**全等，
   * 同名取最后一个，空串 `null`；别的类型 `null`。
   */
  private installEffectAccess(api: ApiObject, object: number): void {
    this.method(api, "getEffectCount", () => {
      const layer = this.findLayer(object);
      return layer?.effectCount ?? layer?.effects.length ?? 0;
    });
    this.method(api, "getEffect", (key?: unknown) => {
      const layer = this.findLayer(object);
      if (!layer) return null;
      if (typeof key === "number" && Number.isInteger(key)) {
        const item = layer.effects.find((effect) => effect.source === key);
        return item ? this.effect(object, item.source) : null;
      }
      if (typeof key === "string" && key !== "") {
        let found: SceneEffect | null = null;
        for (const item of layer.effects) if (this.effectName(object, item.source) === key) found = item;
        return found ? this.effect(object, found.source) : null;
      }
      return null;
    });
  }

  private effect(object: number, effect: number): ApiObject {
    const key = `${object}/${effect}`;
    let api = this.effects.get(key);
    if (api) return api;
    api = this.object();
    this.ownerOf.set(api, object);
    // 键序 `name`、`visible`（`wpe-asset.log` 的 `fx name write`：`JSON.stringify(effect)` 是 `{"name":…,"visible":…}`）
    // `name`（P6d1a）：可读写字符串，只存在 API 这边；写入照类型 5 的 `ToString`，`null` / `undefined` / 抛错的不写
    this.define(
      api,
      "name",
      () => this.effectName(object, effect),
      (value) => {
        const text = scriptToString(value);
        if (text !== undefined) this.effectNames.set(key, text);
      },
    );
    this.define(
      api,
      "visible",
      () => this.access.state().effectEnabled(object, effect),
      (value) => this.write({ kind: "effect", object, effect }, value, "bool"),
    );
    this.method(api, "getMaterialCount", () => this.effectPasses(object, effect).length);
    // 整数取第 i 个 pass 的材质（越界、负数 `null`，无参 = 0）；字符串按 pass 的材质文件路径不分大小写全等、空串匹配每一个，最后一个胜出
    this.method(api, "getMaterial", (...args: unknown[]) => {
      const passes = this.effectPasses(object, effect);
      const arg = args.length === 0 ? 0 : args[0];
      if (typeof arg === "number" && Number.isInteger(arg)) {
        const pass = passes[arg];
        return pass ? this.material(pass.key) : null;
      }
      if (typeof arg === "string") {
        const lower = arg.toLowerCase();
        let found: ScenePass | null = null;
        for (const pass of passes) if (lower === "" || (pass.material ?? "").toLowerCase() === lower) found = pass;
        return found ? this.material(found.key) : null;
      }
      return null;
    });
    this.method(api, "setMaterialProperty", (name?: unknown, value?: unknown) => {
      this.setMaterialProperty(object, effect, name, value);
      return undefined;
    });
    this.installGetAnimation(api, () => `objects/${object}/effects/${effect}`);
    this.effects.set(key, api);
    return api;
  }
  private installGeneral(object: ApiObject): void {
    // TODO:[WPE_SCENE] 没实测：泛光参数与 `GENERAL_FIELDS`（清屏色、环境光、相机 `zoom` 等）的读回仍是 double；图层字段与材质常量
    // 实测是 f32（P3b 补测 `ignore/p3b-f32`），这里大概率同样，测过再按 `f32.ts` 改
    // `bloom` 是运行时状态，不走重编译
    this.define(
      object,
      "bloom",
      () => this.access.state().bloomEnabled,
      (value) => this.write({ kind: "bloom-enabled" }, value, "bool"),
    );
    for (const [name, field] of Object.entries(BLOOM_FIELDS))
      this.define(
        object,
        name,
        () => {
          const value = this.access.state().bloom[field as keyof SceneState["bloom"]];
          return Array.isArray(value) ? this.vector(value, 3) : value;
        },
        (value) =>
          this.write(
            { kind: "bloom", field: field as keyof SceneState["bloom"] },
            value,
            name.endsWith("tint") ? "vec3" : "float",
          ),
      );
    // WPE 里只改字段的属性（L1）：不走重编译。vec3 每次读都是新的 `Vec3`，改它不影响字段（L14）
    for (const key of Object.keys(GENERAL_FIELDS) as GeneralKey[])
      this.define(
        object,
        key,
        () => {
          const value = this.access.state().general[key];
          return Array.isArray(value) ? this.vector(value, 3) : value;
        },
        (value) => this.write({ kind: "general", key }, value, GENERAL_FIELDS[key].type),
      );
    // 只有 `hdr` 保留整场重编译（已定 12），读场景位
    this.define(
      object,
      "hdr",
      () => this.access.bundle().general.postprocess.hdrFlag,
      (value) => this.write({ kind: "recompile", reason: "postprocess-hdr", path: "general/hdr" }, value, "bool"),
    );
  }
}
