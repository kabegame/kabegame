import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EMPTY_ANIMATIONS_PROBE, SceneAnimations, type AnimationsProbe } from "./animation/player";
import { puppetEntries, puppetEntry, ScenePuppets, stateSink } from "./puppet/player";
import { ScenePlayer } from "./audio/player";
import { SceneSounds, type SceneSoundProbe } from "./audio/sceneSounds";
import {
  describeApply,
  mergeProperties,
  pendingChanges,
  planApply,
  type GeneralKey,
  type UserProperty,
} from "./compile/bindings";
import { builtinProperties, WPE_BUILTIN_PROPERTIES, wpeAlignmentOf } from "./compile/builtinProperties";
import type { SceneBundle } from "./compile/bundle";
import type { FragmentDelta, ObjectFragment } from "./compile/fragment";
import { assembleModelDataFragment, modelMaterialCheck, modelTokenOf } from "./modeldata/assemble";
import { ModelDataStore } from "./modeldata/store";
import type { ModelDataDesc } from "./modeldata/types";
import type { PreparedObject } from "./render/scene";
import {
  configBone,
  LiveObjects,
  objectOverridesOf,
  placementBone,
  rebindFragment,
  recompileObjectOf,
  type LiveCreateStats,
  type LiveTarget,
} from "./script/createLayerChange";
import { bindingOwner, SceneRegistry, type RestructureResult } from "./compile/registry";
import type { UserTextureSource } from "./compile/usertextures";
import { openSceneSession, type CompileSessionClient } from "./compile/client";
import { SceneLoadProgress } from "./progress";
import type { SceneStructure } from "./compile/protocol";
import { TextureDecodeCache } from "./compile/decode";
import { FetchSceneReader } from "./compile/fs";
import type { BindingTarget } from "./compile/bindings";
import type { SceneScalar } from "./compile/model";
import {
  readWpeWindowUpdateRate,
  SCENE_POSTPROCESS_SETTINGS,
  SCENE_REFLECTION_SETTINGS,
  SCENE_SHADOW_SETTINGS,
  SCENE_VOLUMETRICS_SETTINGS,
  type SceneReflectionSetting,
  type ScenePostprocessSetting,
  type SceneShadowSetting,
  type SceneVolumetricsSetting,
} from "./compile/postprocess";
import { reflectionOverride } from "./dev/reflectionOverride";
import { shadowsOverride } from "./dev/shadowsOverride";
import { volumetricsOverride } from "./dev/volumetricsOverride";
import { scriptMediaCallbacks } from "./media/events";
import { MEDIA_DEFAULT_INTERVAL_MS, mediaIntervalOf } from "./media/interval";
import { MediaPending } from "./media/pending";
import { SceneMedia, type MediaDelta, type SceneMediaSnapshot } from "./media/scene";
import { closeCover, FLAG_STATUS, EMPTY_PROPS } from "./media/types";
import { reasonsOf, SceneRenderError, SceneRenderer } from "./render";
import { emptyCursorInput, type CursorInputSnapshot } from "./render/cursor";
import { canvasSize, type SceneStyle } from "./render/layout";
import { ScreenResolution } from "./render/screenResolution";
import type { EmitterImageProbe } from "./render/emitterImages";
import { uploadableTextures, visibleObjects } from "./render/scene";
import { SceneState, type SoundValues } from "./render/state";
import { daytimeOf } from "./render/uniforms";
import type { SceneReporter } from "./report";
import { PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN, schemeColor } from "./sceneStyle";
import { instanceControlPoint, type InstanceField } from "./compile/particles";
import { ScriptApi, createWpeLocalStorage, type ParticleScriptTarget } from "./script/api";
import { applyScriptedProperties } from "./script/initialApply";
import {
  addShellObject,
  createStructureObject,
  recordDestroyed,
  recordReparent,
  settleDestroyed,
  syncAllocator,
  trackGroupIssues,
  type ObjectAllocator,
} from "./script/structure";
import { createIframeRealm, getJsModuleIndex } from "./script/realm";
import { ScriptRuntime, scriptDiagnostics, type ScriptTarget, type ScriptValue } from "./script/runtime";
import { readScriptState, recordRecompileWrite, writeScriptState } from "./script/stateWrite";
import { browserStorage, clearSceneStorage } from "./script/storage";
import { sameRuntimeTextFields } from "./text/fields";
import { SceneTexts, type TextRelayouter } from "./text/host";
import type { TextLayout } from "./text/layout";
import { shortcutRequest } from "./shortcut/message";
import { ShortcutToken } from "./shortcut/token";
import { parseShortcutIcon, UserTextureSources, type ShortcutIcon, type UserTextureProbe } from "./usertex/sources";
import { videoSourceKey } from "./video/player";
import { layerVideoSource, SceneVideos, type SceneVideoProbe, type VideoSink } from "./video/sceneVideos";
import { textureAnimationOverride } from "./render/sheets";

interface SceneTarget {
  path: string;
  sceneAssets: string[];
  /**
   * 文本对象的系统字体表（`systemfont_*` 与回退链，P6b 1d2）：名字（WPE 在 `%WINDIR%\Fonts` 下的文件名）→ 本机文件路径。
   * 后端按平台解析（`wallpaper/wpe_scene_host.rs`，和 `file:` 闸门放行的是同一批文件），本机没有的名字不在表里；
   * `text/host.ts` 有表就只查表。
   */
  systemFonts?: Record<string, string> | null;
}

export interface SceneProperty {
  /** 工程里没写 `type` 的项没有（后端照原样给 `{ value }`，见 `UserProperty`）。 */
  type?: string;
  value: unknown;
  /**
   * 快捷方式项（`usershortcut`，P11d）：后端给的形状，`value` 是原值哈希的键（空 = 没配）。`isbound` / `commandtype` / `file` 只进脚本
   * `applyUserProperties` 的增量，`engine.userProperties` 里不带（`script/api.ts` 的 `scriptUserProperties`）；别的类型没有。
   */
  isbound?: boolean;
  commandtype?: string;
  file?: string;
}

/**
 * 宿主计数（dev 探针读）：就地应用次数与每次整场重编译的原因 / 键；运行中建层（L5）的计数：`created.sync` 在 `createLayer` 返回前连 GPU 一起装好的，
 * `async` 之后才装上的（片段异步编、GPU 异步备），`unsupported` 带不支持项、没装 GPU 的。`recompiledObjects`（L6）：交给单对象重编译的次数（每次
 * 对象级的重编译写入、每个属性改动涉及的每个对象各算一次，合并之前的；这些不进 `recompiled`）。`restructured`（L7）：结构变化（换父、删除生效）当场
 * 重算组与挂点、交给渲染器当帧重排的次数（不再整场重编译，不进 `recompiled`）。
 */
export interface SceneHostStats {
  applied: number;
  recompiled: { reason: string; keys: string[] }[];
  created: LiveCreateStats;
  recompiledObjects: number;
  restructured: number;
}

const LOST_RETRY_WINDOW_MS = 60_000;
/** 还没收到 `general.fps` 时的帧率：Kabegame 帧率设置的缺省值。 */
const DEFAULT_FPS = 30;
/** 第一次 ready 之前最多等视频纹理出第一帧这么久（P9a 决定 1）。 */
const FIRST_VIDEO_FRAME_TIMEOUT_MS = 2000;
/** dev 覆盖：有不支持项也照常渲染（生产构建摇掉）；用户设置「强制渲染」经父页面的场景设置消息来，两者取或 */
const FORCE_RENDER_KEY = "kabegame-dev-scene-force-render";

function devForceRender(): boolean {
  if (!__SCENE_DEV__) return false;
  try {
    return localStorage.getItem(FORCE_RENDER_KEY) === "1";
  } catch {
    return false;
  }
}

function asPostprocess(value: unknown): ScenePostprocessSetting {
  return SCENE_POSTPROCESS_SETTINGS.includes(value as ScenePostprocessSetting)
    ? (value as ScenePostprocessSetting)
    : "follow";
}

function asReflection(value: unknown): SceneReflectionSetting {
  return SCENE_REFLECTION_SETTINGS.includes(value as SceneReflectionSetting)
    ? (value as SceneReflectionSetting)
    : "follow";
}

function asShadows(value: unknown): SceneShadowSetting {
  return SCENE_SHADOW_SETTINGS.includes(value as SceneShadowSetting) ? (value as SceneShadowSetting) : "follow";
}

function asVolumetrics(value: unknown): SceneVolumetricsSetting {
  return SCENE_VOLUMETRICS_SETTINGS.includes(value as SceneVolumetricsSetting)
    ? (value as SceneVolumetricsSetting)
    : "follow";
}

/** 父页面下发的五项设置（已规整） */
interface SceneSettings {
  postprocess: ScenePostprocessSetting;
  reflection: SceneReflectionSetting;
  shadows: SceneShadowSetting;
  volumetrics: SceneVolumetricsSetting;
  /** 用户设置「强制渲染」：有不支持项也照常渲染（只认 `true`） */
  forceRender: boolean;
}

const FOLLOW_SCENE_SETTINGS: SceneSettings = {
  postprocess: "follow",
  reflection: "follow",
  shadows: "follow",
  volumetrics: "follow",
  forceRender: false,
};

/** 首次加载等父页面场景设置的上限：父页面在宿主请求后同一轮事件里就回，正常是几毫秒 */
const SCENE_SETTINGS_WAIT_MS = 3000;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 日志里的泛光状态：有链不等于开着，当前开不开看场景位。 */
function bloomLabel(bloom: SceneBundle["bloom"], enabled: boolean): string {
  if (!bloom) return "无泛光";
  const label = enabled ? "泛光" : "泛光（关）";
  return bloom.hdr ? `${label} + HDR` : label;
}

/**
 * 第一次 ready 之前要等第一帧的视频纹理（P9a 决定 1）：当前可见（含父链；按渲染器的状态，脚本 `init` 的写入已经在里面）的图层的
 * pass、effect、粒子、passthrough 用到的视频纹理下标，取法同 `uploadableTextures`。拿不到状态时退化成全部视频纹理。
 */
function visibleVideoTextures(bundle: SceneBundle, state: SceneState | null | undefined): number[] {
  const all = (bundle.textures ?? []).flatMap((texture, index) => (texture.video ? [index] : []));
  if (!state || !all.length) return all;
  const visible = new Set(visibleObjects(bundle.layers, state));
  const used = uploadableTextures({ layers: bundle.layers.filter((layer) => visible.has(layer.object)) });
  return all.filter((index) => used.has(index));
}

/**
 * 加载时等用户纹理预解码的上限（毫秒）：同视频第一帧的等待思路（`FIRST_VIDEO_FRAME_TIMEOUT_MS`）——要等到第一帧就是用户图，但不能让读不出 /
 * 很慢的文件无限拖住加载。超时后照常建场景、这些槽先用缺省纹理，解码完成后走运行时的换图路径换上。
 */
export const USER_TEXTURE_PRIME_TIMEOUT_MS = 5000;

/** 每个 iframe 只有一个 SceneHost；属性由垫片推送，实例随 iframe 一同销毁。 */
export class SceneHost {
  private style: SceneStyle = "fill";
  /** 父页面量的显示缩放（`sceneStyle.ts` 的协议），渲染器建好前先存着。 */
  private displayScale = 1;
  /**
   * 最近一次的指针（画布上的归一化坐标，`setPointer`），没收到过为 null。渲染器建好前先存着、建好时带进去（P5a 收尾）：
   * 父页面交来的开场初值往往早于渲染器，丢了的话加载时的预热与第一帧都只能按场景中心算。
   */
  private pointer: [number, number] | null = null;
  /**
   * 左键（P6c，`setButton`）与脚本 `input.*` 的本帧光标快照：渲染器建好前先存着左键、建好时带进去；快照由渲染器每个实时帧给、`input` 每次现读。
   */
  private button = false;
  private cursorInput: CursorInputSnapshot = emptyCursorInput();
  private renderer: SceneRenderer | null = null;
  private rendererTask: Promise<SceneRenderer> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private state: "idle" | "loading" | "ready" | "fallback" = "idle";
  private lastFallback = "";
  private lastLostAt = -Infinity;
  private disposed = false;
  private paused = false;
  /**
   * 帧率（垫片的 `applyGeneralProperties` 带来的 `general.fps`，Rust 已解析好「跟随 WPE」与预览 / 桌面的数据源）：建渲染器时传入、
   * 运行中就地改（`setGeneral`）。收到之前按 Kabegame 的缺省 30（首包与用户属性同批送达，实际早于建渲染器）。
   */
  private fps = DEFAULT_FPS;
  /** 播放速度（父页面的 `kabegame:wpe-scene-rate`，`setPlaybackRate`）：建渲染器、视频、声音时带上，运行中就地改。 */
  private playbackRate = 1;
  /** 设置「场景后处理」：最近一次加载用的值；还没加载过为 null。 */
  private postprocess: ScenePostprocessSetting | null = null;
  /**
   * 父页面下发的后处理 / 反射 / 阴影 / 体积光（`kabegame:wpe-scene-settings`，`setSceneSettings`）：桌面是全局「壁纸设置」，预览是这张壁纸的
   * 「预览设置」，宿主不分。收到第一条之前为 null，`reload` 等它（最多 `SCENE_SETTINGS_WAIT_MS`，等不到按跟随 WPE）。
   */
  private sceneSettings: SceneSettings | null = null;
  private readonly sceneSettingsWaiters: (() => void)[] = [];
  /** 设置「场景反射」（P13b1）：最近一次加载用的值；还没加载过为 null。 */
  private reflection: SceneReflectionSetting | null = null;
  /** 设置「场景阴影」（P13d）：最近一次加载用的值；还没加载过为 null。 */
  private shadows: SceneShadowSetting | null = null;
  /** 设置「场景体积光」（P13e）：最近一次加载用的值；还没加载过为 null。 */
  private volumetrics: SceneVolumetricsSetting | null = null;
  /** 设置「强制渲染」：最近一次加载用的值；还没加载过为 null。 */
  private forceRenderSetting: boolean | null = null;
  /**
   * 累计全集（WPE 渲染器 `+0x1728`，I1）：键 → `{ type, value }`。保留 `type`，不学 WPE 的整项覆盖（I4）。
   * 加载传全集、运行时传增量，两条路都走 `apply`。
   */
  private readonly properties = new Map<string, UserProperty>();
  /**
   * 宿主补进全集的 WPE 内置属性（P3a 修复，`compile/builtinProperties.ts`）：首包里工程没声明的那几个。`alignment` 在这里时跟着
   * 壁纸样式走（`setStyle`）；工程自己声明了的不在这里，以工程的为准。
   */
  private readonly hostBuiltins = new Set<string>();
  /** 当前场景编译时用的裸值快照；场景换上后与全集比较，补上加载期间到达的增量。 */
  private compiledWith: Record<string, unknown> = {};
  /** 当前场景的 bundle（取绑定表）与渲染器（就地写）。 */
  private bundle: SceneBundle | null = null;
  /** 常驻的编译会话（L2）：只在用得上时留着（见 `sessionUseful`），L5 起运行中建层用它编片段。场景换上时（`beforeFirstFrame`）换手。 */
  private compileSession: CompileSessionClient | null = null;
  /**
   * 当前场景的运行中建层（L5，`script/createLayerChange.ts`）：片段缓存 + 变更队列 + 两条路，属于当前的会话与登记表。场景换上时（`beforeFirstFrame`）
   * 换成新场景的（旧的放弃），退回与销毁时丢掉。`beforeFrame` 开头 `drain`。
   */
  private live: LiveObjects<PreparedObject> | null = null;
  /**
   * 首次加载 / 清空脚本存储后重建脚本环境时，脚本 `init` 期间建层用的（L5 点 4）：属于这次加载的会话与登记表，还没有 GPU 场景（命中缓存的当场接进 bundle，
   * 没命中的 `init` 之后等片段到齐再接），场景换上时成为 `live`。
   */
  private loadingLive: LiveObjects<PreparedObject> | null = null;
  /** 同 `loadingLive`：这次加载的登记表（L7：`init` 里换父 / 删除时重算组与挂点的是它，建 GPU 场景时自然带上）。 */
  private loadingRegistry: SceneRegistry | null = null;
  /**
   * 运行中出现的组内不支持组合（L7，`trackGroupIssues`）：因为它不画的对象 → 键，属于当前场景（换场景时清空）。`groupHidden` 是其中卸过 GPU 运行时
   * （或接进来时没装）的，问题消失时照常装回来。
   */
  private readonly groupIssues = new Map<number, string[]>();
  private readonly groupHidden = new Set<number>();
  /** 交给渲染器、还没重排的结构变化（L7）：这一帧脚本之后 `flushRestructure` 做掉，出错整场重载。 */
  private restructurePending = false;
  private scriptBundle: SceneBundle | null = null;
  private scriptState: SceneState | null = null;
  /**
   * 当前场景的登记表（L3b，`compile/registry.ts`）：建 GPU 场景之前为这份 bundle 建一个（L4：粒子序号从它取），场景换上时（`beforeFirstFrame`）
   * 成为当前的，换场景 / 重编译时换新的，退回与销毁时丢掉。`addCompiledObject` 经它加 / 换对象，删除生效处（`onDestroyed`）经它摘对象（L4）。
   */
  private registry: SceneRegistry | null = null;
  /** 用户纹理来源的种类表（名字 → 种类）：加载时按 bundle 建，`addCompiledObject` 带来新来源时补（`state.onUserTexture` 查它）。 */
  private userTextureKinds = new Map<string, UserTextureSource["kind"]>();
  private runtime: ScriptRuntime | null = null;
  /**
   * 脚本的 `engine.screenResolution`（显示缩放为 1 的画布像素，`render/screenResolution.ts`），跨渲染器共用：渲染器每次量画布都交给它，变了就调脚本的
   * `resizeScreen`（WPE 的 `WM_SIZE`；布局或 DPR 变了才算，预览放大只改显示缩放）。运行时只发给跑完 `init` 的脚本；回调里写的字段同属性面板的
   * 写入，下一次同步生效。首次加载的 `init` 早于建渲染器，见 `scriptScreenResolution`。
   */
  private readonly screen = new ScreenResolution((width, height) => this.runtime?.resizeScreen(width, height));
  private scriptApi: ScriptApi | null = null;
  /**
   * 脚本模型数据仓（P14，`thisScene.createModelData`）：生命周期跟脚本 realm 一致——建运行时（`startRuntime`）时新建，运行时丢掉（清空脚本存储、销毁）时丢掉；
   * 整场重载保留 realm，token 一直有效。图层引用在 `createLayer` 建壳时记、删除生效时放（`removeObjectEverywhere`）。
   */
  private modelData: ModelDataStore | null = null;
  private readonly scriptOverrides = new Map<string, ScriptValue>();
  /**
   * 运行中改过的场景结构（P6d3a）：删掉的对象、换过的父。每次 `reload` 交给编译（删掉的不回来、换过的父保留），跨重编译保留；
   * 「清空脚本存储」时清空，回到 `scene.json` 原样。
   */
  private readonly structure: SceneStructure = { destroyed: [], parents: [], created: [] };
  /** 新建对象的下标分配器（P6d3b）：只增不减、跨重编译保留，「清空脚本存储」时清零；每份新 bundle 换上 / 编出时 `syncAllocator`。 */
  private readonly allocator: ObjectAllocator = { next: 0 };
  private scriptReloadPending = false;
  private scriptReloadRunning = false;
  private reloading = false;
  /**
   * 整场重载进行中、它的新场景还没换上（L6）：这段时间里的对象级重编译写入照旧整场再重载一次——新场景的编译可能已经取过覆盖表，写入落在旧场景上，
   * 换上之后就丢了。新场景换上（`beforeFirstFrame`）起，写入交给新场景的单对象重编译。
   */
  private switchPending = false;
  private scriptUnavailable = false;
  private scriptNeedsFullApply = true;
  private runtimeTask: Promise<void> | null = null;
  private readonly consoleErrors = new Map<string, { minute: number; count: number; skipped: number }>();
  /** 音频只订一次（被拒也不重试）；`audioFrames` 只给 dev 探针读。 */
  private audioSubscribed = false;
  private audioError: string | null = null;
  private audioFrames = 0;
  /**
   * 系统媒体集成（P11c，`media/`）：`bundle.media` 时第一次加载建，重编译保留（订阅只订一次、被拒也不重试；`SceneMedia` 的状态、队列与
   * 脚本 realm 一样跨重编译），销毁时释放。消息先进 `MediaPending`（按 WPE 合并），一个 `windowupdaterate` 间隔的计时器把它切成事件推进
   * `SceneMedia` 的队列，每帧脚本阶段开头取空（`drainMedia`）。
   */
  private sceneMedia: SceneMedia | null = null;
  private mediaPending: MediaPending | null = null;
  private mediaTimer: ReturnType<typeof setInterval> | null = null;
  private mediaInterval = MEDIA_DEFAULT_INTERVAL_MS;
  private mediaSubscribed = false;
  private mediaError: string | null = null;
  /** dev 探针：最近收到的消息（封面只记 PNG 的 base64 长度），带 `performance.now()`。 */
  private readonly mediaMessages: { t: number; message: unknown }[] = [];
  /**
   * Hub 最近一次推来的原始频谱（128 个值，左 64 + 右 64，P4e 步骤 4）：宿主只存最近一份，渲染器每帧开头取它推进场景频谱
   * （`SceneRendererOptions.audioFrame`）。还没收到时为 null。
   */
  private lastAudioFrame: number[] | null = null;
  /**
   * 声音对象的播放（P6a 步骤 1）：第一张带声音的 bundle 到达时建，重编译保留（同一对象播放不中断），退回预览图与销毁时释放。
   * 宿主音量 h 由垫片交来（`setHostVolume`），收到之前按 0：不建 `AudioContext`、不读文件。
   */
  private sceneSounds: SceneSounds | null = null;
  private soundPlayer: ScenePlayer | null = null;
  private hostVolume = 0;
  private hidden = false;
  /**
   * 文本对象的排版（P6b 1d，`text/host.ts`）：第一张带文本层的 bundle 到达时建，wasm 实例与读过的字体跨重编译保留，每次加载新建图集。
   * 运行中重排（1e）：每次加载的重排器（`relayouter()`）随 `load` 交给渲染器，缺字体读完经 `onTextReady` 标脏。
   */
  private sceneTexts: SceneTexts | null = null;
  /**
   * 视频纹理的播放（P9a 步骤 2）：第一张带视频纹理的 bundle 到达时建，重编译保留（按区间复用播放器，决定 2），退回预览图与销毁时释放。
   * `videoBundle` 是它的下标表对应的 bundle（`loadVideos`），`drawingBundle` 是渲染器正在画的那份（换场景那一刻记下）。
   */
  private sceneVideos: SceneVideos | null = null;
  private videoBundle: SceneBundle | null = null;
  private drawingBundle: SceneBundle | null = null;
  /**
   * 属性关键帧动画的播放器（P10a 步骤 3，`animation/player.ts`）：每次场景换上（`load` 的 `beforeFirstFrame`）按那份 bundle 新建，
   * 按 `id` 接回上一份的时钟与缓存（`carryOver`），所以重编译时动画接着走、不重新开始（WPE 改属性不重载）；换上之前旧场景还在画，
   * 用的是旧的这份。退回预览图与销毁时丢掉，下次能渲染时从 0 开始（同 WPE 重开壁纸）。
   */
  private sceneAnimations: SceneAnimations | null = null;
  /**
   * puppet 的骨骼动画运行时（P12a 步骤 4 点 4，`puppet/player.ts`）：每次场景换上（`load`）按那份 bundle 新建，`carryOver` 接回上一份的
   * 动画层时钟（同 P10：WPE 改属性不重载场景），`refresh` 按新状态算一次姿势，第一帧就是当前姿势而不是绑定姿势。每个实时帧由渲染器的
   * `stepPuppets` 推进。退回预览图与销毁时丢掉。
   */
  private scenePuppets: ScenePuppets | null = null;
  /**
   * 首次加载（或「清空脚本存储」后重建脚本环境）时，脚本 `init` 要用的动画播放器（P10b 步骤 3）：WPE 先登记全部动画再跑 `init`，所以
   * `init(){ thisObject.getAnimation().play() }` 开场就播。`init` 在 `beforeFirstFrame` 建播放器之前跑，这里先按新 bundle 建好，
   * `ScriptApi.animation` 在它属于脚本当前看到的 bundle 时取它；`beforeFirstFrame` 换上它时**不** `carryOver`（动画从头来，`init` 里的
   * 控制要保留），不是同一份 bundle（加载期间又重编译了）就作废、照旧新建并接旧时钟。退回预览图、销毁时丢掉。
   */
  private pendingAnimations: { bundle: SceneBundle; player: SceneAnimations } | null = null;
  /**
   * 首次加载时脚本 `init` 要用的 puppet 运行时（P12c，同 `pendingAnimations`）：语料里 50 处「相位偏移」脚本在 `init` 里对动画层 `setFrame`，
   * 所以在 `ensureRuntime` 之前按新 bundle 先建好。`ScriptApi.puppetLayers` 在它属于脚本当前看到的 bundle 时取它；`load` 里属于这份 bundle 时
   * 直接交给渲染器、`beforeFirstFrame` 里**不** `carryOver`（`init` 里的控制要保留），否则作废、照旧新建并接上正在播的。退回预览图、销毁时丢掉。
   */
  private pendingPuppets: { bundle: SceneBundle; puppets: ScenePuppets } | null = null;
  /**
   * 交给渲染器的 `VideoSink`：同一份转给当前的 `sceneVideos`，没有时空操作。重编译时 `loadVideos` 在新场景换上之前就按新 bundle 的
   * 下标重建了表（好早点读新出现的视频），这期间旧场景还在画、问的是旧下标：按视频区间换算成新下标，换算不到（新 bundle 里没有这段
   * 视频）就不交帧，免得把别的视频拷进旧场景的纹理。
   */
  private readonly videoSink: VideoSink = {
    beginFrame: () => this.sceneVideos?.beginFrame(),
    drawn: (texture) => {
      const videos = this.sceneVideos;
      if (!videos) return null;
      const drawing = this.drawingBundle;
      const loaded = this.videoBundle;
      if (!drawing || !loaded || drawing === loaded) return videos.drawn(texture);
      const source = drawing.textures?.[texture]?.video;
      if (!source) return null;
      const key = videoSourceKey(source);
      const index = (loaded.textures ?? []).findIndex((item) => !!item.video && videoSourceKey(item.video) === key);
      return index < 0 ? null : videos.drawn(index);
    },
  };
  /**
   * 渲染器还没有场景时（首次加载：脚本的 `init` 先于渲染器建场景）脚本对粒子层调的方法（P4f 步骤 3）：按调用顺序记下，场景换上时
   * （`beforeFirstFrame`，重放脚本写入之后）逐个补调到新场景上；`paused` / `stopped` 只用来回答这期间的 `isPlaying`【推】。退回与销毁时丢掉。
   */
  private readonly pendingParticles: {
    calls: { object: number; call: (target: ParticleScriptTarget) => void }[];
    states: Map<number, { paused: boolean; stopped: boolean }>;
  } = { calls: [], states: new Map() };
  /** dev 探针计数：就地应用次数与重编译记录、运行中建层的计数。 */
  readonly stats: SceneHostStats = {
    applied: 0,
    recompiled: [],
    created: { sync: 0, async: 0, unsupported: 0 },
    recompiledObjects: 0,
    restructured: 0,
  };
  private receivedProperties = false;
  private readonly reader = new FetchSceneReader();
  /**
   * 用户纹理的来源表（P11b 步骤 2，`usertex/sources.ts`）：属性来源的当前值与解码结果，宿主一份、跨重编译保留（重编译不重新解码），销毁时释放。
   * 加载时对 bundle 的属性来源预先解码（`primeUserTextures`），运行中经 `SceneState.onUserTexture` 收新值、解码完成回调 `onUserTextureReady`。
   * `read` 与 `log` 是闭包：构造函数里的 `options` 在字段初始化时还没赋值。
   */
  private readonly userTextures = new UserTextureSources((path) => this.reader.readWhole(path), {
    log: (message) => this.options.report.debug(`场景壁纸 ${this.options.imageId} ${message}`),
    // 用户视频的播放器 warning（P11b 步骤 4）
    report: { warn: (message, detail) => this.options.report.warn(message, detail) },
    // 快捷方式图标（P11d）：按图片 id 与属性名向后端要，非 Windows、没配、取不到都是 0 字节（= 缺省纹理）
    shortcutIcon: (name) => this.fetchShortcutIcon(name),
  });
  /**
   * 快捷方式的点击令牌（P11d，`shortcut/token.ts`）：渲染器每个实时帧在光标派发之前 `beginFrame`、之后 `endFrame`（`ensureRenderer` 的 `cursor`），
   * `engine.openUserShortcut` 经 `openUserShortcut` 取它。
   */
  private readonly shortcutToken = new ShortcutToken();
  private readonly textureCache = new TextureDecodeCache(this.reader);
  private targetTask: Promise<SceneTarget> | null = null;
  private readonly unlisteners: UnlistenFn[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: {
      imageId: string | null;
      report: SceneReporter;
      /** 加载时等用户纹理预解码的上限（毫秒），缺省 `USER_TEXTURE_PRIME_TIMEOUT_MS`；单测用。 */
      userTexturePrimeTimeoutMs?: number;
      /** 把快捷方式启动请求交给父页面（P11d）；缺省 `window.parent.postMessage(消息, "*")`，单测用。 */
      postToParent?: (message: unknown) => void;
    },
  ) {
    this.userTextures.onReady = (name) => this.onUserTextureReady(name);
    // 来源表建好后按当前暂停状态设一次（P11b 步骤 4，用户视频与 GIF 的时钟）
    this.userTextures.setPaused(this.paused || this.hidden);
    // 应用页与这份存储不同来源，由后端广播：同一张图的全部宿主（预览、桌面）都停脚本、删前缀、重建
    this.listenEvent<{ imageId?: string }>("wpe-scene-clear-storage", "清空脚本存储", (payload) => {
      const imageId = options.imageId;
      if (!this.disposed && imageId && payload?.imageId === imageId) this.restartScriptsWithClearedStorage(imageId);
    });
  }

  private listenEvent<T>(name: string, label: string, handler: (payload: T) => void): void {
    void listen<T>(name, (event) => handler(event.payload))
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisteners.push(unlisten);
      })
      .catch((error) => this.options.report.warn(`监听${label}失败：`, error));
  }

  /** 垫片的属性入口：运行时与首次加载走同一个应用函数（加载传全集、运行时传增量，I7 第 1 条）。 */
  applyUserProperties(changed: Record<string, SceneProperty>): void {
    this.apply(changed);
  }

  /**
   * 把一批属性并进累计全集（跳过 group / text / 空值、宿主侧按值去重），再按绑定表分成就地写与重编译。
   * 没有任何绑定引用的属性（只给脚本用、或作者声明了却没绑）什么都不做。
   */
  private apply(delta: Record<string, SceneProperty>): void {
    // 首包 = 全集：补上 WPE 注入的内置属性（WPE 首次加载就带着，绑定与脚本都看得到），工程声明了同名属性时以工程的为准
    if (!this.receivedProperties) delta = this.withBuiltins(delta);
    const changes = mergeProperties(this.properties, delta);
    if (changes.has("schemecolor")) this.renderer?.setBackground(schemeColor(this.properties));
    if (!this.receivedProperties) {
      // 首包 = 全集：整场编译（这时不会用增量路径）
      this.receivedProperties = true;
      void this.reload();
      return;
    }
    if (!changes.size) return;
    // 退回预览图时没有 bundle 可就地写；改了属性可能就能渲染（例如关掉不支持的 effect，关着的 effect 不计入场景级），重新编译
    if (this.state === "fallback") {
      void this.reload();
      return;
    }
    // 加载中不丢：落地后按 `compiledWith` 的差异再走一次
    if (this.state !== "ready" || !this.bundle) return;
    this.applyChanges(changes);
  }

  /** 首包补上工程没声明的内置项（`alignment` 按当前壁纸样式），记进 `hostBuiltins`。 */
  private withBuiltins(delta: Record<string, SceneProperty>): Record<string, SceneProperty> {
    const builtins: Record<string, SceneProperty> = {};
    for (const [key, property] of Object.entries(builtinProperties(this.style))) {
      if (Object.hasOwn(delta, key)) continue;
      builtins[key] = property;
      this.hostBuiltins.add(key);
    }
    return { ...builtins, ...delta };
  }

  /**
   * 按当前 bundle 的绑定表应用一批变化。要重编译的（重编译目标，或 `needsRecompile` 挡下了就地写的）按路径分级（L6）：全是对象级（`objects/<i>/…`、
   * 打开带不支持项 / 冻结图层的 effect）时其余照常就地写，涉及的对象各交给单对象重编译；有场景级的（`general/hdr`、没有泛光链时打开泛光等）或接不上
   * 单对象重编译时整场重编译。
   */
  private applyChanges(changes: ReadonlyMap<string, SceneScalar>): void {
    const bundle = this.bundle;
    if (!bundle) return;
    // 片段缓存（L5）：按这些属性整场重编译的片段作废（对象已删、只剩缓存里的那些宿主看不到，见 `FragmentCache.dropBoundTo`）
    this.live?.cache.dropBoundTo(changes.keys());
    const plan = planApply(bundle.bindings, changes);
    // 写之前问：打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景时 `applyBindings` 一条都不写，这几条按重编译目标处理
    const state = this.renderer?.sceneState;
    const blockedWrites = state ? plan.writes.filter((write) => state.needsRecompile(write.binding, write.value)) : [];
    const blocked = blockedWrites.map((write) => write.binding.target);
    const blockedPaths = blocked.map((target) => this.targetPath(target));
    // 分级（L6）：重编译目标按路径；挡下的 effect 开关是它的对象的，泛光开关是场景级
    const objects = new Set<number>();
    let sceneLevel = false;
    for (const item of plan.recompile) {
      const object = recompileObjectOf(item.path);
      if (object === null) sceneLevel = true;
      else objects.add(object);
    }
    for (const target of blocked) {
      if (target.kind === "effect") objects.add(target.object);
      else sceneLevel = true;
    }
    const objectLevel = !sceneLevel && objects.size > 0;
    // 全是对象级：挡下的那几条不写（由重编译决定），其余照常就地写；否则照旧（有一条挡下就一条都不写）
    const writes = objectLevel ? plan.writes.filter((write) => !blockedWrites.includes(write)) : plan.writes;
    const applied = this.renderer?.applyBindings(writes) ?? false;
    if (applied) {
      for (const { binding } of writes) this.runtime?.forgetWrite(this.targetPath(binding.target));
      // 声音的 `volume` 当场生效（WPE 的回调 `V` 在改值时调；暂停时没有帧）
      if (writes.some(({ binding }) => binding.target.kind === "sound")) this.syncSoundVolumes();
      this.stats.applied++;
      this.options.report.debug(`场景壁纸 ${this.options.imageId} 就地更新：${[...changes.keys()].join(",")}`);
    }
    for (const path of [...plan.recompile.map((item) => item.path), ...blockedPaths]) {
      this.runtime?.forgetWrite(path);
      this.scriptApi?.forgetRecompile(path);
      this.scriptOverrides.delete(path);
    }
    this.runtime?.applyUserProperties(
      Object.fromEntries([...changes].map(([key]) => [key, this.properties.get(key)!])),
      this.properties,
      bundle.bindings,
    );
    // 单对象重编译在编期间（L6）属性又改了这个对象的绑定（就地写了）：在编的片段按发请求那一刻的属性编，换上时会把这次改动盖回去（被挡下的写不回来，
    // 不支持项也按旧值判）——同「在编时又写了」，记一次，到达后按当前属性再发
    if (applied) {
      const owners = new Set<number>();
      for (const { binding } of writes) {
        const owner = bindingOwner(binding);
        if (owner !== null) owners.add(owner);
      }
      for (const owner of owners) {
        const live = this.objectLive(owner);
        if (live?.recompilingObject(owner)) this.recompileWith(live, owner);
      }
    }
    // 对象级（L6）：每个对象交给单对象重编译（属性值会话按请求里的属性全集取，不进覆盖；覆盖只带脚本写过的）。先确认都接得上，再一起发
    if (objectLevel && applied) {
      const lives = [...objects].map((object) => [object, this.objectLive(object)] as const);
      if (lives.every(([, live]) => live !== null)) {
        for (const [object, live] of lives) this.recompileWith(live!, object);
        this.options.report.debug(
          `场景壁纸 ${this.options.imageId} 单对象重编译：对象 ${[...objects].join("、")}（${[...changes.keys()].join(",")}）`,
        );
        if (this.paused) this.renderer?.redraw();
        return;
      }
    }
    if (plan.recompile.length || !applied || blocked.length) {
      const blockedTag = (label: string, kind: BindingTarget["kind"]) => {
        const paths = blocked.filter((target) => target.kind === kind).map((target) => this.targetPath(target));
        return paths.length ? [`${label}（${paths.join("、")}）`] : [];
      };
      const reasons = [
        ...(plan.recompile.length ? [describeApply(plan)] : []),
        ...blockedTag("effect-blocked", "effect"),
        ...blockedTag("bloom-missing", "bloom-enabled"),
      ];
      const reason = reasons.join("；") || "就地写失败";
      const unsupported = blocked.flatMap((target) => (target.kind === "effect" ? this.effectIssues(target) : []));
      this.stats.recompiled.push({ reason, keys: [...changes.keys()] });
      this.options.report.debug(
        `场景壁纸 ${this.options.imageId} 重新编译：${reason}（${[...changes.keys()].join(",")}）` +
          (unsupported.length ? `，不支持项：${unsupported.join(",")}` : ""),
      );
      void this.reload();
      return;
    }
    // 暂停时循环不跑，补画一帧。放在脚本的属性回调之后：回调的写入也要进这一帧
    if (this.paused) this.renderer?.redraw();
  }

  /**
   * 「清空脚本存储」：停脚本、删本场景的存储、重建脚本环境（`init` 重跑）。不重启的话，内存里的值很快又会被写回去。
   * 音频订阅保留（`audioSubscribed` 不复位）：每帧从场景频谱拷进当时的 `scriptApi`，新脚本注册的缓冲照样收到。
   */
  private restartScriptsWithClearedStorage(imageId: string): void {
    const hadRuntime = this.runtime !== null;
    // 先停脚本再删：destroy 回调可能还会写
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
    this.modelData = null;
    // 视频的脚本状态一并复位（P9b）：新脚本的 IVideoTexture 是缺省值（loop 真、rate 1），播放器也要是；旧脚本登记的结束回调不会再调，
    // 留着只会拖住旧的脚本环境
    this.sceneVideos?.resetScriptState();
    // 动画一起从头来（P10b 决定 1）：重建后 runtime 为 null，`reload` 会走「先按新 bundle 建待用播放器」的分支（`pendingAnimations`），
    // 新 `init` 里的 play() 落在它上面，`beforeFirstFrame` 换上时不接旧时钟；所以这里不用碰 `sceneAnimations`（旧场景在新场景换上前照常画）
    // 脚本写过的重编译目标一并放弃；用户属性在重建后重新全量交给新脚本
    this.scriptOverrides.clear();
    this.structure.destroyed = [];
    this.structure.parents = [];
    this.structure.created = [];
    this.allocator.next = 0;
    // 运行中建层（L5）：排着的片段与备着的 GPU 对象作废（建它们的脚本已停、结构已清；新脚本环境的场景换上时另有一份）
    this.disposeLive();
    this.scriptNeedsFullApply = true;
    const backend = browserStorage();
    if (backend) clearSceneStorage(backend, imageId);
    // 退回预览图时脚本不跑，只删存储；下次能加载时自然重建
    if (!hadRuntime || this.state === "fallback") return;
    this.stats.recompiled.push({ reason: "clear-storage", keys: [] });
    this.options.report.debug(`场景壁纸 ${imageId} 已清空脚本存储，重启脚本`);
    void this.reload();
  }

  /** 一个 effect 自己的不支持项（`effect` 是 JSON 下标）。 */
  private effectIssues(target: { object: number; effect: number }): string[] {
    const layer = this.bundle?.layers.find((item) => item.object === target.object);
    return layer?.effects.find((item) => item.source === target.effect)?.unsupported ?? [];
  }

  private targetPath(target: BindingTarget): string {
    if (target.kind === "layer") return `objects/${target.object}/${target.field}`;
    // `rotateObjectSpace`（P6d1a）：与 `angles` 同键
    if (target.kind === "rotation") return `objects/${target.object}/angles`;
    if (target.kind === "effect") return `objects/${target.object}/effects/${target.effect}/visible`;
    if (target.kind === "constant") return `${target.pass}/constantshadervalues/${target.material}`;
    if (target.kind === "bloom") return `general/bloom/${target.field}`;
    // 与 `scriptOverrides` 的路径相同：兜底重编译时编译器读得到
    if (target.kind === "bloom-enabled") return "general/bloom";
    if (target.kind === "general") return `general/${target.key}`;
    if (target.kind === "particle-instance") return `objects/${target.object}/instanceoverride/${target.field}`;
    if (target.kind === "sound") return `objects/${target.object}/${target.field}`;
    // 灯字段（P13f2）：同脚本运行时的 `targetKey`
    if (target.kind === "light") return `objects/${target.object}/${target.field}`;
    // 文本字段（P6b 1e）：同脚本运行时重放表的键
    if (target.kind === "text") return `objects/${target.object}/${target.field}`;
    // MSDF 装饰参数（P6f）：同上，脚本写不到它，只有属性写
    if (target.kind === "text-decor") return `objects/${target.object}/${target.field}`;
    // 相机对象的 `fov` / `zoom`（P5d 步骤 3）
    if (target.kind === "camera") return `objects/${target.object}/${target.field}`;
    // 场景相机的基准（P5e）：同脚本运行时的 `targetKey`
    if (target.kind === "camera-base") return `general/camera/${target.field}`;
    if (target.kind === "recompile") return target.path;
    // 用户纹理（P11b）：同脚本运行时的 `targetKey`
    if (target.kind === "user-texture") return `usertextures/${target.name}`;
    // 纹理变体的条件属性（P11e）：同脚本运行时的 `targetKey`
    if (target.kind === "texture-variant") return `texturevariants/${target.path}/${target.name}`;
    // puppet 动画层字段（P12a 步骤 3 点 3）：同脚本运行时的 `targetKey`
    if (target.kind === "animation-layer")
      return `objects/${target.object}/animationlayers/${target.layer}/${target.field}`;
    // 材质状态字段（P6d1b）：同脚本运行时的 `targetKey`
    if (target.kind === "pass-state") return `${target.pass}/state/${target.field}`;
    return `${target.script}/scriptproperties/${target.key}`;
  }

  /** 读法与 dev 探针共用（`script/stateWrite.ts`）。 */
  private readScript(target: ScriptTarget): ScriptValue | null {
    const state = this.scriptState;
    if (!state) return null;
    return readScriptState(state, target);
  }

  private writeScript(target: ScriptTarget, value: ScriptValue): boolean {
    // 重编译类目标不看状态：值记进覆盖表、请求整场重编译
    if (target.kind === "recompile") return this.overrideAndReload(target.path, value);
    const state = this.scriptState;
    if (!state) return false;
    // 写进状态的规则与 dev 探针共用（`script/stateWrite.ts`）：文本字段按脚本侧规则规整、值变了才标脏重排，其余经 `SceneState.write`；
    // 写不进的目标（`unsupported`、`script-property`）返回 false
    const result = writeScriptState(state, target, value);
    // `unsupported` 目标总是写不进（这里另判一次只为收窄类型）
    if (result === "unsupported" || target.kind === "unsupported") return false;
    // 声音的 `volume`（P6a 步骤 2：API 写入与字段脚本写回）当场交给排期器：WPE 的回调 `V` 在改值时调、没有渐变，暂停时也生效。
    // 读脚本看到的状态：首次加载 `init` 期间它还不是渲染器的状态（首帧前重放写入时再同步一次）
    // `mintime` / `maxtime` 不用推：排期器在开始播放时现读状态（P6a2）
    if (target.kind === "sound" && target.field === "volume") {
      const volume = state.sounds.get(target.object)?.volume;
      if (volume !== undefined) this.sceneSounds?.scheduler(target.object)?.setVolume(volume);
    }
    // 打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景：状态没变，结果由整场编译决定，编译要拿到脚本的值
    return result === "recompile" ? this.overrideAndReload(this.targetPath(target), value) : true;
  }

  /**
   * 粒子层脚本方法的落点（P4f 步骤 3，`ScriptApiState.particles`）：渲染器有场景时接到它的根系统（`SceneRenderer.particleScript`；重编译
   * 期间是还在画的旧场景，新场景换上时由渲染器沿用暂停 / 停止，`GpuScene.adoptParticleScripts`）。还没有场景时（首次加载的 `init`）先记下，
   * 换上时补调（`flushPendingParticles`）【推：WPE 的 `init` 在粒子系统建好之后跑，这些调用当场生效；我们的场景晚建，补调保留调用顺序，
   * `emitParticles` 发出的粒子在第一帧照常增龄后画】。脚本 bundle 里不是粒子层的对象返回 null。
   */
  private particleTarget(object: number): ParticleScriptTarget | null {
    const renderer = this.renderer;
    if (renderer?.sceneState) return renderer.particleScript(object);
    if (!this.scriptBundle?.layers.some((layer) => layer.object === object && layer.particle)) return null;
    const pending = this.pendingParticles;
    const state = () => {
      let item = pending.states.get(object);
      if (!item) pending.states.set(object, (item = { paused: false, stopped: false }));
      return item;
    };
    const record = (call: (target: ParticleScriptTarget) => void) => pending.calls.push({ object, call });
    return {
      play: () => {
        record((target) => target.play());
        Object.assign(state(), { paused: false, stopped: false });
      },
      pause: () => {
        record((target) => target.pause());
        state().paused = true;
      },
      stop: () => {
        record((target) => target.stop());
        state().stopped = true;
      },
      // 场景建好后系统一般是活跃的（预热过或有没结束的发射器），所以没暂停、没停下就算在放
      isPlaying: () => !state().paused && !state().stopped,
      emitParticles: (count) => record((target) => target.emitParticles(count)),
    };
  }

  /** 场景换上时补调首次加载期间记下的粒子层方法（`particleTarget`），按调用顺序。 */
  private flushPendingParticles(renderer: SceneRenderer): void {
    const { calls, states } = this.pendingParticles;
    states.clear();
    for (const { object, call } of calls.splice(0)) {
      const target = renderer.particleScript(object);
      if (target) call(target);
    }
  }

  /**
   * 脚本写重编译类目标：值变了才记进覆盖表、请求重新编译（脚本可能每帧写同一个值）。「变没变」与 dev 探针共用
   * （`script/stateWrite.ts` 的 `recordRecompileWrite`）。对象级的（路径 `objects/<i>/…`，L6）只重编这一个对象（`objectLive`）；场景级的（`general/…`）
   * 或接不上单对象重编译时照旧整场重编译（覆盖表照记，整场编译读它）。
   */
  private overrideAndReload(path: string, value: ScriptValue): boolean {
    if (!recordRecompileWrite(this.scriptOverrides, this.scriptBundle?.general, path, value)) return true;
    this.options.report.debug(`场景脚本重编译目标变化：${path}`);
    const object = recompileObjectOf(path);
    const live = object === null ? null : this.objectLive(object);
    if (live) {
      this.recompileWith(live, object!);
      return true;
    }
    this.stats.recompiled.push({ reason: `script（${path}）`, keys: [] });
    this.requestScriptReload();
    return true;
  }

  /**
   * 对象级重编译（L6）交给哪一份运行中的单对象重编译：`init` 还在跑（首次加载或清空脚本存储后）时是这次加载的 `loadingLive`（片段到齐后接进还没换上的
   * bundle，建 GPU 场景时一起建，不再整场编第二次）；平时是当前场景的 `live`，要它的编译会话还留着（`sessionUseful`）。整场重载进行中、新场景还没换上时
   * （`switchPending`：写入可能晚于这次编译取覆盖表的时刻，照旧再整场一次）、对象不在脚本状态里或已删时为 null，调用方照旧整场重编译。
   */
  private objectLive(object: number): LiveObjects<PreparedObject> | null {
    const live = this.runtimeTask
      ? this.loadingLive
      : !this.switchPending && this.compileSession && !this.compileSession.broken
        ? this.live
        : null;
    if (!live || !this.scriptState?.layers.has(object) || this.structure.destroyed.includes(object)) return null;
    // 被依赖的图层（别的图层按名字绑它的独占合成 RT）L6b 起也走这条路：替换时形状相同沿用旧 RT、变了引用方重绑（`GpuScene.installCore`）
    return live;
  }

  /**
   * 交给单对象重编译（L6）：覆盖取 `scriptOverrides` 里这个对象累计的全部，父取脚本状态里运行中的，挂点骨骼名按 `placementBone`，运行中建的对象带上
   * 它的配置原文（`structure.created`，会话可能没见过它）；计一次 `recompiledObjects`。
   */
  private recompileWith(live: LiveObjects<PreparedObject>, object: number): void {
    live.recompile(
      object,
      objectOverridesOf(this.scriptOverrides, object),
      {
        parent: this.scriptState?.layers.get(object)?.parent ?? null,
        bone: placementBone(this.scriptBundle ?? {}, this.structure, object),
      },
      this.structure.created.find((item) => item.object === object)?.config ?? "",
    );
    this.stats.recompiledObjects++;
  }

  /**
   * `setParent` 改完状态（P6d3a）：记进结构（之后每次编译带上），登记表当场重算组与挂点（L7，`restructure`），变了的交给 `applyRestructure`：
   * 渲染器当帧重排（进组当帧画进组的合成 RT，同 WPE），不再整场重编译。组深度检查失败后父被置空的也走这里。
   */
  private onReparented(change: {
    object: number;
    oldParent: number | null;
    oldBone: string | null;
    parent: number | null;
    bone: string | null;
  }): void {
    recordReparent(this.structure, change.object, change.parent, change.bone);
    const registry = this.scriptRegistry();
    const state = this.scriptState;
    if (!registry || !state) return;
    this.stats.restructured++;
    this.applyRestructure(
      registry,
      registry.restructure(state, (item) => this.restructureBone(registry.bundle, item)),
    );
  }

  /** 脚本当前看到的那份登记表（L7）：`init` 期间（首次加载或清空脚本存储后）是这次加载的，平时是当前的；都对不上 `scriptBundle` 时 null。 */
  private scriptRegistry(): SceneRegistry | null {
    const bundle = this.scriptBundle;
    if (this.loadingRegistry?.bundle === bundle) return this.loadingRegistry;
    return this.registry?.bundle === bundle ? this.registry : null;
  }

  /** 渲染器画的正是脚本状态（场景已换上、没在加载新场景），GPU 的装卸与重排才落在它上面。 */
  private gpuCurrent(registry: SceneRegistry): boolean {
    const renderer = this.renderer;
    return registry === this.registry && !!renderer?.sceneState && renderer.sceneState === this.scriptState;
  }

  /**
   * 结构变化之后（L7）：登记表 `restructure` 的结果交到这里（换父、删除生效、`addCompiledObject` 接进对象）。
   * - 不是当前场景的登记表（`init` 期间那份，还没有 GPU）：派生量建场景时自然带上；组内不支持组合同编译期，并进它的 `bundle.unsupported`（建场景时
   *   整场退回预览图，之前是整场重编译后同样退回）。
   * - 当前场景：组内不支持组合按「待定」4（`trackGroupIssues`）：新出现的那个对象不画（卸 GPU 运行时）、`report.unsupported` 提示一次，场景不退回；
   *   问题消失的照常装回来（同步备不好就整场重载）。其余派生量变了、已装 GPU 的对象交给渲染器，这一帧脚本之后（`flushRestructure`）当帧重排。
   * `skip`：不交给渲染器的对象（`addCompiledObject` 接进来的那个，GPU 由 `LiveObjects` 接着装）。返回这次新出现问题的对象 → 键。
   */
  private applyRestructure(
    registry: SceneRegistry,
    result: RestructureResult,
    skip: number | null = null,
  ): Map<number, string[]> {
    const { bundle } = registry;
    if (registry !== this.registry) {
      const keys = [...trackGroupIssues(new Map(), result, bundle.layers).added.values()].flat();
      if (keys.length > 0) {
        const unsupported = bundle.unsupported;
        for (const key of keys) if (!unsupported.includes(key)) unsupported.push(key);
        unsupported.sort();
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 加载中的结构变化，组内用法不支持：`, [
          ...new Set(keys),
        ]);
      }
      return new Map();
    }
    const { added, cleared } = trackGroupIssues(this.groupIssues, result, bundle.layers);
    const gpu = this.gpuCurrent(registry);
    const renderer = this.renderer;
    for (const [object, keys] of added) {
      this.options.report.debug(
        `场景壁纸 ${this.options.imageId} 运行中的结构变化让对象 ${object} 用到不支持的组内用法，不画：${keys.join(",")}`,
      );
      this.options.report.unsupported?.(keys);
      if (gpu && object !== skip && renderer!.hasObject(object)) {
        renderer!.removeObject(object);
        this.groupHidden.add(object);
      }
    }
    for (const object of cleared) {
      if (!this.groupHidden.delete(object) || !gpu || object === skip) continue;
      const layer = bundle.layers.find((item) => item.object === object);
      if (!layer || !this.scriptState?.layers.has(object)) continue;
      try {
        const prepared = renderer!.prepareObjectSync(layer);
        if (!prepared) throw new Error("程序没有就绪");
        renderer!.installObject(prepared);
      } catch (error) {
        this.reloadAfterRestructure(`对象 ${object} 出组后装回失败：${String(error)}`);
      }
    }
    const objects = [...result.changed].filter((object) => object !== skip && !this.groupIssues.has(object));
    if (gpu && objects.length > 0) {
      renderer!.restructure(objects);
      this.restructurePending = true;
    }
    return added;
  }

  /**
   * 交给渲染器的结构变化这一帧做掉（L7，`beforeFrame` 的脚本与删除生效之后、绘制之前）：重排失败（规划问题、管线建不出、合成 RT 建不出）时整场重载
   * 兜底（结构里照记，重载后一致）。没交过的什么都不做；渲染器的 `sync` 也会做（暂停时的补画帧），那里出错就只能退回。
   */
  private flushRestructure(): void {
    if (!this.restructurePending) return;
    this.restructurePending = false;
    const renderer = this.renderer;
    if (!renderer?.sceneState || renderer.sceneState !== this.scriptState) return;
    try {
      renderer.flushRestructure();
    } catch (error) {
      this.reloadAfterRestructure(`重排失败：${String(error)}`);
    }
  }

  /** 换场景 / 退回 / 销毁（L7）：运行中的组内问题与没做的重排属于旧场景，丢掉。 */
  private resetRestructure(): void {
    this.groupIssues.clear();
    this.groupHidden.clear();
    this.restructurePending = false;
  }

  /** 结构变化接不上（L7）：记一条、整场重载（同 `LiveObjects` 的 `reload`）。 */
  private reloadAfterRestructure(reason: string): void {
    this.stats.recompiled.push({ reason: `script（结构变化 ${reason}）`, keys: [] });
    this.options.report.debug(`场景壁纸 ${this.options.imageId} 结构变化退回整场重载：${reason}`);
    this.requestScriptReload();
  }

  /**
   * `createLayer` 的落点（P6d3b，L5）：在脚本状态上建出壳并记进结构（`createStructureObject`），再交给运行中建层的两条路（`LiveObjects.create`）：
   * - 命中片段缓存：当场接进登记表、状态、子系统，GPU 能同步备好就当场装上，`createLayer` 返回之后 `init` 读到的就是编好的状态，这一帧就画出；
   * - 没命中：排进变更队列，会话异步编，片段到了在之后某一帧开头装上（已知差异：第一次出现的配置晚几帧）。
   * `init` 还在跑（`runtimeTask`，首次加载或清空脚本存储后）时交给这次加载的 `loadingLive`：命中的当场接进这份 bundle，没命中的 `init` 之后等片段
   * 到齐再接（`reload`），建 GPU 场景时一起建，首帧就带新对象。重载进行中建的照常落在当前场景上，新场景换上时再建一次（`beforeFirstFrame`）。
   */
  private onCreateLayer(config: string, parent: number | null): number | null {
    const state = this.scriptState;
    if (!state) return null;
    syncAllocator(this.allocator, this.scriptBundle);
    const object = createStructureObject(state, this.structure, this.allocator, config, parent);
    if (object === null) return null;
    this.options.report.debug(`场景脚本建了图层：${object}`);
    // 脚本模型数据层（P14）：图层引用在壳建好时就记（之后脚本 `destroyModelData` 也不会让它在图层底下释放，S15）
    const token = modelTokenOf(config);
    if (token !== null) this.modelData?.retainLayer(token, object);
    const live = this.runtimeTask ? this.loadingLive : this.live;
    if (!live) {
      // 没有会话（不该发生）：退回整场重载，结构里记着它
      this.stats.recompiled.push({ reason: `script（createLayer ${object}，没有编译会话）`, keys: [] });
      this.requestScriptReload();
      return object;
    }
    this.createOn(
      live,
      this.scriptRegistry()?.bundle ?? null,
      object,
      config,
      state.layers.get(object)?.parent ?? null,
    );
    return object;
  }

  /**
   * 运行中建层的两条路之上再分一层（P14 方案甲）：配置里 `model` 是数字 token 且有描述时，先试主线程同步拼片段（`assembleModelDataFragment`，条件见它的文件头），
   * 拼得出就当场接进场景（同命中缓存，`createLayer` 返回前这一帧就画出）；拼不出（材质没预编、配置带绑定等）或查不到描述就走 Worker 路，请求带描述
   * （`LiveTarget.modelData`）——查不到 token 的编出不画的层（S16）。别的配置照旧 `live.create`。
   */
  private createOn(
    live: LiveObjects<PreparedObject>,
    bundle: SceneBundle | null,
    object: number,
    config: string,
    parent: number | null,
  ): void {
    const token = modelTokenOf(config);
    const desc = token === null ? null : (this.modelData?.desc(token) ?? null);
    if (desc && bundle) {
      const fragment = assembleModelDataFragment({ object, id: object, parent, config, desc, bundle });
      if (fragment) {
        live.landAssembled(fragment);
        return;
      }
    }
    live.create(object, config, parent);
  }

  /** 建模型数据时的材质检查（`ModelDataStore.create` / `replace`）：按脚本当前看到的 bundle 里的模板查（P14）。0 通过、1 材质读不到、2 着色器要的顶点属性格式给不出。 */
  private materialCheck(material: string, format: number): 0 | 1 | 2 {
    return modelMaterialCheck(this.scriptBundle ?? this.bundle, material, format);
  }

  /** 整场编译 / 会话要带的描述：`structure.created` 里还没删的、配置用数字 token 的对象，各取数据仓里 token 当前的描述（重载后这些层仍在，P14）。 */
  private collectModelData(): Record<number, ModelDataDesc> {
    const out: Record<number, ModelDataDesc> = {};
    const store = this.modelData;
    if (!store) return out;
    for (const { object, config } of this.structure.created) {
      if (this.structure.destroyed.includes(object)) continue;
      const token = modelTokenOf(config);
      if (token === null || token in out) continue;
      const desc = store.desc(token);
      if (desc) out[token] = desc;
    }
    return out;
  }

  /**
   * 数据仓的结构变了（`replaceData` 改了形状数 / 格式 / 材质 / 容量，P14）：对每个引用这个 token 的、在场景里的图层重新拼装并按「替换」接回；
   * 拼不了的走 L6 的单对象重编译（带新描述，`LiveTarget.modelData`），接不上单对象重编译就整场重载。只管登记表、状态、片段；GPU 侧缓冲随 `source`
   * 按 token / 形状取，重建是步骤 3b 的事。图层还在排队没接进来（Worker 路没到）时旧描述的片段到达后由 `modelFragmentStale` 的核对发现过期、再重拼。
   */
  private onModelDataStructure(token: number): void {
    const store = this.modelData;
    if (!store) return;
    for (const object of store.layersOf(token)) this.rebuildModelObject(object);
  }

  /** 按数据仓里 token 当前的描述重建一个模型数据层（见 `onModelDataStructure`）。 */
  private rebuildModelObject(object: number): void {
    const state = this.scriptState;
    const created = this.structure.created.find((item) => item.object === object);
    if (!state?.layers.has(object) || !created || this.structure.destroyed.includes(object)) return;
    const registry = this.scriptRegistry();
    // 还没接进登记表（壳；Worker 路的片段在路上）：到达时核对（`modelFragmentStale`）
    if (!registry?.bundle.layers.some((layer) => layer.object === object)) return;
    const live = this.runtimeTask ? this.loadingLive : this.live;
    const token = modelTokenOf(created.config);
    const desc = token === null ? null : (this.modelData?.desc(token) ?? null);
    const parent = state.layers.get(object)?.parent ?? null;
    const fragment =
      live && desc
        ? assembleModelDataFragment({
            object,
            id: object,
            parent,
            config: created.config,
            desc,
            bundle: registry.bundle,
          })
        : null;
    if (live && fragment) {
      live.landAssembled(fragment, "replace");
      return;
    }
    const recompiler = this.objectLive(object);
    if (recompiler) this.recompileWith(recompiler, object);
    else {
      this.stats.recompiled.push({ reason: `script（模型数据 ${token} 结构变化，对象 ${object}）`, keys: [] });
      this.requestScriptReload();
    }
  }

  /**
   * 片段接进场景之后核对（P14）：模型数据层的片段是按编它（或发请求）那一刻的描述编的，到达前 `replaceData` 可能又改了结构——网格的格式 / 顶点数 /
   * 索引 / 材质和数据仓现在的不一致就按新描述再拼一次。
   */
  private modelFragmentStale(fragment: ObjectFragment): boolean {
    const token = modelTokenOf(fragment.config);
    if (token === null) return false;
    const desc = this.modelData?.desc(token);
    if (!desc) return false;
    const meshes = fragment.layer.model?.meshes;
    if (!meshes) return desc.shapes.length > 0;
    if (meshes.length !== desc.shapes.length) return true;
    return desc.shapes.some((shape, i) => {
      const mesh = meshes[i];
      return (
        mesh.format !== shape.format ||
        mesh.vertexCount !== shape.vertexCount ||
        mesh.indexCount !== (shape.indexFormat ? shape.indexCount : 0) ||
        mesh.material !== shape.material
      );
    });
  }

  /**
   * 运行中建层接进场景的那一侧（L5，`LiveTarget`），绑定一份登记表（一次加载、一个会话）。登记表还不是当前的（这次加载的 `init` 期间）时：子系统取待用的
   * （`pendingAnimations` / `pendingPuppets`）、文本排版交给 `loadingTexts`（建 GPU 场景时用）、没有 GPU；成为当前的之后（场景换上）照常。
   * `loading.pending` 收集 `init` 期间接入的异步部分（文本排版、用户纹理解码），建 GPU 场景之前等它；`loading.reload` 记 `init` 期间请求过整场重载。
   */
  private liveTarget(
    registry: SceneRegistry,
    loading: { texts: Map<number, TextLayout>; pending: Promise<void>[]; reload: string | null },
  ): LiveTarget<PreparedObject> {
    const current = (): boolean => this.registry === registry;
    const gpu = (): boolean => {
      const renderer = this.renderer;
      return current() && !!renderer?.sceneState && renderer.sceneState === this.scriptState;
    };
    return {
      alive: (object) => !!this.scriptState?.layers.has(object) && !this.structure.destroyed.includes(object),
      applyDelta: (delta) => registry.applyDelta(delta),
      adopt: (input) => {
        const switched = current();
        const pending = this.addCompiledObject(input, "replace", {
          deltaApplied: true,
          registry,
          ...(switched ? {} : { loadingTexts: loading.texts }),
        });
        if (!switched) loading.pending.push(pending.catch(() => {}));
        // 模型数据层（P14）：片段按发请求时的描述编，到达前结构变了就在这一帧装完之后按新描述再来一次（排在 GPU 装入之后）
        if (this.modelFragmentStale(input.fragment)) {
          const object = input.fragment.object;
          queueMicrotask(() => this.rebuildModelObject(object));
        }
        return pending;
      },
      gpu,
      prepareSync: (layer) => this.renderer!.prepareObjectSync(layer),
      prepare: (layer) =>
        gpu() ? this.renderer!.prepareObject(layer) : Promise.reject(new Error("场景已经换了，不再备这个对象")),
      // 异步备好的对象装上之前，结构变化让它进了用到不支持用法的组（L7）：不装（出组时由 `applyRestructure` 照常装回来）
      install: (prepared) => {
        const object = prepared.layer.object;
        if (current() && this.groupIssues.has(object)) {
          this.renderer!.discardPrepared(prepared);
          this.groupHidden.add(object);
        } else this.renderer!.installObject(prepared);
      },
      discard: (prepared) => this.renderer?.discardPrepared(prepared),
      warm: async (layer) => {
        if (!gpu()) return;
        const renderer = this.renderer!;
        const prepared = await renderer.prepareObject(layer);
        renderer.discardPrepared(prepared);
      },
      unsupported: (object, keys) => {
        this.options.report.debug(
          `场景壁纸 ${this.options.imageId} 运行中接入的对象 ${object} 用到不支持的特性，不画：${keys.join(",")}`,
        );
        this.options.report.unsupported?.(keys);
      },
      // 单对象重编译的片段带不支持项（L6）：旧的运行时卸掉，这个对象不画
      removeGpu: (object) => {
        if (gpu()) this.renderer!.removeObject(object);
      },
      reload: (reason) => {
        this.stats.recompiled.push({ reason: `script（${reason}）`, keys: [] });
        this.options.report.debug(`场景壁纸 ${this.options.imageId} 运行中接入对象退回整场重载：${reason}`);
        // `init` 期间：这次加载放弃、带结构重编（`reload` 里看它）
        if (!current()) loading.reload ??= reason;
        else this.requestScriptReload();
      },
      properties: () => Object.fromEntries([...this.properties].map(([key, property]) => [key, property.value])),
      // 脚本模型数据的描述（P14）：发片段请求时现取
      modelData: (config) => {
        const token = modelTokenOf(config);
        const desc = token === null ? null : (this.modelData?.desc(token) ?? null);
        return desc ? { [desc.token]: desc } : undefined;
      },
    };
  }

  /**
   * 删除生效之后（P6d3a）：记进结构、声音停播并摘掉、光标的悬停 / 按下集合摘掉（不发 Leave / Up）。
   * L3b 起顺带清各子系统与状态里被删对象的残留（关键帧、puppet、文本排版引用、状态的按对象的表），只少占内存，不改画面。
   * L4 起登记表一起摘；L7 起一律接着 `restructure`（挂点、子对象变根后的父、删组后子层回顶层），变了的交给 `applyRestructure`，渲染器在这一帧脚本之后
   * 先释放被删对象（`releaseRemoved`）、再按新的组与挂点重排：删组当帧剩下的子层由顶层画（同 WPE），不再整场重编译。
   */
  private onDestroyed(objects: number[]): void {
    recordDestroyed(this.structure, objects);
    for (const object of objects) {
      this.groupIssues.delete(object);
      this.groupHidden.delete(object);
    }
    // 声音停播并摘掉、关键帧 / puppet / 文本排版的残留、状态的按对象的表、登记表（L3b、L4）与组和挂点的重算（L7）
    const restructured = this.removeObjectEverywhere(objects);
    this.renderer?.forgetObjects(objects);
    this.options.report.debug(`场景脚本删除了图层：${objects.join(",")}`);
    if (!restructured) return;
    this.stats.restructured++;
    this.applyRestructure(restructured.registry, restructured.result);
  }

  /**
   * 把一个编好的对象接进当前场景（L3b）。mode `"add"`：新对象；`"replace"`：替换已有对象（L5 运行中建层由壳换成编好的、L6 单对象重编译）。
   * 同步部分按顺序：登记表（先场景级增量，再对象）→ 状态 → `restructure`（组与挂点重算；骨骼名取配置原文的 `attachment`，`override` 取
   * `structure.parents` 是否带这个对象；结果交给 `applyRestructure`，L7：别的对象当帧重排、组内不支持组合那个对象不画）→ 绑定按当前属性重写
   * （L5，`rebindFragment`）→ 关键帧（替换时 `replaceObjects` 按 id 接回时钟，L6）→ puppet → 文本（排版异步起，回来写状态）→ 脚本（`refreshScripts`
   * 换成定型后的条目，再 `replayWritesFor` 重放这个对象建出以来的写入，L6 替换时运行中写过的字段靠它留着）→ `ScriptApi.adoptBundle` → 声音 → 视频纹理
   * → 用户纹理（预解码异步）→ 媒体 / 音频订阅。GPU 不在这里：L5 的 `LiveObjects` 在它之后备、装（同一顺序，GPU 最后）。
   * `"replace"` 时登记表里还没有这个对象（L5：运行中建层的壳只在状态里）就走 `addObject`，状态照旧 `replaceObject`。
   * 选项（L5）：`deltaApplied` 场景级增量已在片段到达时进了登记表（只登记用户纹理来源等宿主侧的表）；`registry` 接进哪份登记表（缺省当前的；
   * 这次加载 `init` 期间是还没换上的那份，子系统取待用的 `pendingAnimations` / `pendingPuppets`）；`loadingTexts` 文本排版回来另交到这张表（建 GPU 场景用）。
   * 返回要等的异步部分（文本排版、用户纹理解码、补建媒体集成）。登记表与状态都还没建（没有场景）时抛错。
   */
  private addCompiledObject(
    delta: FragmentDelta | { fragment: ObjectFragment },
    mode: "add" | "replace",
    options: { deltaApplied?: boolean; registry?: SceneRegistry; loadingTexts?: Map<number, TextLayout> } = {},
  ): Promise<void> {
    const registry = options.registry ?? this.registry;
    const state = this.scriptState;
    if (!registry || !state) throw new Error("没有场景，不能接对象");
    // 子系统：登记表是当前的就取当前的，否则（这次加载的 `init` 期间）取属于这份 bundle 的待用运行时
    const switched = registry === this.registry;
    const animations = switched
      ? this.sceneAnimations
      : this.pendingAnimations?.bundle === registry.bundle
        ? this.pendingAnimations.player
        : null;
    const puppets = switched
      ? this.scenePuppets
      : this.pendingPuppets?.bundle === registry.bundle
        ? this.pendingPuppets.puppets
        : null;
    const { fragment } = delta;
    const object = fragment.object;
    const only = new Set([object]);
    const pending: Promise<void>[] = [];
    // 1. 登记表 → 状态 → 组与挂点重算
    if ("programs" in delta && !options.deltaApplied) registry.applyDelta(delta);
    // 替换时先取旧排版：状态换对象会清掉它，引用要放回图集
    const previousText = mode === "replace" ? state.texts.get(object) : undefined;
    if (mode === "add") {
      registry.addObject(fragment);
      state.addObject(fragment);
    } else {
      if (registry.bundle.layers.some((layer) => layer.object === object)) registry.replaceObject(fragment);
      else registry.addObject(fragment);
      state.replaceObject(fragment);
    }
    // 组与挂点重算（L7）：派生量变了的别的对象（如接进来的对象挂进了组合层，组合层成了组）交给渲染器当帧重排；接进来的对象自己的 GPU 由 `LiveObjects`
    // 接着装（同 `prepareObjectSync` 按当前的组规划），这里不交。它自己用到组内不支持的用法时把键并进片段的 `unsupported`：`LiveObjects` 据此不装
    // GPU（替换时卸掉旧的）、上报，同片段自带的不支持项（L5 / L6）；之后出组时照常装回来（`groupHidden`）
    const restructured = registry.restructure(state, (item) => this.restructureBone(registry.bundle, item));
    const added = this.applyRestructure(
      registry,
      { changed: new Set([...restructured.changed, object]), issues: restructured.issues },
      object,
    );
    const own = added.get(object) ?? (registry === this.registry ? this.groupIssues.get(object) : undefined);
    if (own && fragment.unsupported.length === 0) {
      fragment.unsupported = [...own];
      this.groupHidden.add(object);
    }
    // 1b. 绑定按当前属性全集重写（L5）：缓存里的片段按编它那一刻的属性编的。有被 `needsRecompile` 挡下的（L6：编它之后属性改了冻结图层 / 带不支持项的
    // effect 的开关，片段过期了）时，接完之后这个对象再交一次单对象重编译
    let stale = false;
    rebindFragment(state, fragment, this.properties, () => (stale = true));
    // 2. 关键帧：替换时按 id 接回时钟（L6：单对象重编译不让动画从头来；L5 的壳没有关键帧，接不到什么）
    if (mode === "replace") animations?.replaceObjects(only, fragment.animations);
    else animations?.add(fragment.animations);
    // 3. puppet
    if (mode === "replace") puppets?.remove(only);
    puppets?.add(puppetEntry(fragment.layer));
    // 4. 文本。替换一个已有排版的文本层（L6 单对象重编译，如换字体）：旧排版先放回状态——旧的运行时在新的装上之前照画、每帧读它（`state.texts`），
    // 新排版回来、换进状态时才放掉状态里原来那份的引用（排版不出来时旧的留在状态里）。状态对它里面的每份排版持一个引用
    if (previousText && fragment.layer.text) state.setText(object, previousText);
    else if (previousText) this.sceneTexts?.releaseLayout(previousText);
    if (fragment.layer.text) {
      const texts = (this.sceneTexts ??= new SceneTexts({
        reader: this.reader,
        report: this.options.report,
        onReady: (item) => this.onTextReady(item),
      }));
      const loadingTexts = options.loadingTexts;
      const compiledFields = fragment.layer.text.fields;
      pending.push(
        texts.layoutInCurrent(fragment.layer).then((layout) => {
          // 排版回来时对象可能又被删 / 换了：状态里没有文本对象就放掉引用
          if (!layout) return;
          if (this.scriptState === state && state.layers.has(object)) {
            const current = state.texts.get(object);
            state.setText(object, layout);
            if (current && current !== layout) texts.releaseLayout(current);
            // 这份排版按编译期字段排，状态里的字段这时可能已被下面第 5 步的脚本重放或运行中写入改过（L6 替换：文本脚本写过「NIGHT」，
            // 重放先于这份排版回来，期间按「NIGHT」排好的排版被上面盖掉，之后脚本每帧写同一串、不再标脏，就一直停在编译期的初值）。
            // 不同时标脏，下一次 `sync` 按状态里的字段重排（WPE 重建时按对象当前的字段排）
            const live = state.textFields.get(object);
            if (live && compiledFields && !sameRuntimeTextFields(live, compiledFields)) state.touchText(object);
            // 这次加载 `init` 期间接入的：建 GPU 场景时交给渲染器（它按 bundle 另建状态）
            loadingTexts?.set(object, layout);
          } else texts.releaseLayout(layout);
        }),
      );
    }
    // 5. 脚本：换成定型后的条目，重放这个对象建出以来的写入；API 的待编对象清掉
    this.runtime?.refreshScripts(fragment.scripts);
    this.runtime?.replayWritesFor(only);
    this.scriptApi?.adoptBundle();
    // 6. 声音
    this.loadSounds(registry.bundle);
    // 6b. 视频纹理（L5）：增量带来新的视频纹理时按 bundle 重建播放器表（同区间的播放器复用）
    if ("textures" in delta && delta.textures.list.some((texture) => texture.video)) this.loadVideos(registry.bundle);
    // 7. 用户纹理：新来源的种类登记、预解码
    const fresh = "userTextures" in delta ? delta.userTextures.list : [];
    for (const source of fresh) this.userTextureKinds.set(source.name, source.kind);
    if (fresh.length > 0) pending.push(this.primeUserTextureSources(fresh).then(() => {}));
    // 7b. 过期的片段（见 1b）：按当前属性再编一次；接不上单对象重编译时（重载进行中）由重载之后的属性补差（`pendingChanges`）处理
    if (stale) {
      const live = this.objectLive(object);
      if (live) this.recompileWith(live, object);
    }
    // 8. 媒体 / 音频：只会从假变真，没订阅才订
    if (fragment.audio) this.subscribeAudio();
    if (fragment.media && !this.sceneMedia) {
      pending.push(
        (this.targetTask ?? Promise.resolve(null)).then((target) =>
          this.loadMedia(registry.bundle, target?.sceneAssets ?? []),
        ),
      );
    }
    return Promise.all(pending).then(() => {});
  }

  /** `restructure` 的骨骼回调：当前挂点骨骼名取配置原文的 `attachment`，`override`（允许父排在后面）取 `structure.parents` 是否带这个对象。 */
  private restructureBone(bundle: SceneBundle, object: number): { name: string | null; override: boolean } {
    return configBone(bundle, this.structure, object);
  }

  /**
   * 删除生效之后（`flushDestroy` 返回的对象，L3b），按和 `addCompiledObject` 相反的顺序从各处摘掉：声音（停播）→ 文本排版引用（要在状态清表之前取）→
   * puppet → 关键帧 → 状态按对象的表（`dropObject`）→ 登记表（`removeObject`）→ 最后 `restructure` 一次（被删对象的子对象已成根，组与挂点要重算）。
   * 脚本已由 `runtime.destroyObjects` 清；用户纹理来源是场景级的、媒体 / 音频订阅是只增的，都不摘。返回 `restructure` 的结果与那份登记表（调用方交给
   * `applyRestructure`，L7）；没碰登记表时 null。
   *
   * 选项：`structural: false` 只清子系统与状态，不碰登记表（L3b 时删除路径的形态）。L7 起删除一律 `restructure`（删组后子层回顶层，渲染器当帧重排）。
   * L3b 审读的另一个阻碍（`ScriptApi.newLayerId` 按 `bundle.layers` 取最大 id，删掉最大 id 的层会让它被重新发出）L4 改成单调分配器解决；
   * `findLayer` / `getLayerByID` 按活的 bundle 找，删掉的找不到是对的。其余各处（状态的按对象的表、关键帧、puppet、文本排版）渲染侧读它们都带空值保护，
   * 且 `releaseRemoved` 在同一帧下一次 `sync` 先于任何读取释放被删对象的 draw。
   */
  private removeObjectEverywhere(
    objects: readonly number[],
    options: { structural?: boolean } = {},
  ): { registry: SceneRegistry; result: RestructureResult } | null {
    if (objects.length === 0) return null;
    const { structural = true } = options;
    const set = new Set(objects);
    const state = this.scriptState;
    // 脚本模型数据层：放掉图层引用（P14，S15：最后一个用它的图层删掉后数据才释放）
    if (this.modelData)
      for (const object of objects) {
        const config = this.structure.created.find((item) => item.object === object)?.config;
        const token = config === undefined ? null : modelTokenOf(config);
        if (token !== null) this.modelData.releaseLayer(token, object);
      }
    this.sceneSounds?.remove(objects);
    if (this.sceneTexts && state)
      for (const object of objects) {
        const layout = state.texts.get(object);
        if (layout) this.sceneTexts.releaseLayout(layout);
      }
    this.scenePuppets?.remove(set);
    this.sceneAnimations?.removeObjects(set);
    if (state) for (const object of objects) state.dropObject(object);
    if (!structural) return null;
    const registry = this.registry;
    if (!registry) return null;
    for (const object of objects) registry.removeObject(object);
    if (!state) return null;
    return { registry, result: registry.restructure(state, (item) => this.restructureBone(registry.bundle, item)) };
  }

  private requestScriptReload(): void {
    this.scriptReloadPending = true;
    if (this.reloading || this.scriptReloadRunning || this.disposed) return;
    this.scriptReloadRunning = true;
    queueMicrotask(async () => {
      try {
        while (this.scriptReloadPending && !this.disposed && !this.reloading) {
          this.scriptReloadPending = false;
          await this.reload();
        }
      } finally {
        this.scriptReloadRunning = false;
        if (this.scriptReloadPending && !this.reloading) this.requestScriptReload();
      }
    });
  }

  private scriptConsoleError(text: string): void {
    const id = this.runtime?.currentScript?.id ?? "<module>";
    const minute = Math.floor(Date.now() / 60_000);
    const item = this.consoleErrors.get(id) ?? { minute, count: 0, skipped: 0 };
    if (item.minute !== minute) {
      item.minute = minute;
      item.count = 0;
    }
    if (item.count < 10) {
      this.options.report.warn(
        `场景脚本 ${id} console.error：${text}${item.skipped ? `（前面省略 ${item.skipped} 条）` : ""}`,
      );
      item.count++;
      item.skipped = 0;
    } else item.skipped++;
    this.consoleErrors.set(id, item);
  }

  /**
   * 向 `WpeMediaHub` 订阅音频，Hub 有订阅才开回环采集。两处触发（P4e 步骤 4）：加载的 bundle「场景用音频」（`SceneBundle.audio`：
   * `project.json` 声明了开关、且有 `audioprocessingmode ≠ 0` 的粒子模块），或脚本第一次注册音频缓冲。订阅归属宿主 frame，frame 销毁时由
   * Phase 8 的 `SubframeDestroyed` 释放，没有退订命令；重编译保留 realm、缓冲与渲染器的场景频谱，也不用重订。
   * 收到的原始频谱只存最近一份（`lastAudioFrame`，消息的 `raw`：Hub 另算的 WPE 采集线程原值；`data` 是网页壁纸用的自定频谱，场景不读），
   * 渲染器每帧取它推进场景频谱，粒子与脚本缓冲都读归一化后的频谱。
   */
  private subscribeAudio(): void {
    const imageId = this.options.imageId;
    if (this.audioSubscribed || !imageId) return;
    this.audioSubscribed = true;
    const channel = new Channel<{ type: string; data?: number[]; raw?: number[] }>();
    channel.onmessage = (message) => {
      if (message.type !== "audio" || !message.raw) return;
      this.audioFrames++;
      this.lastAudioFrame = message.raw;
    };
    // 没声明 supportsaudioprocessing 或非 Windows 时被拒：不报错（同 Phase 8 垫片），只记 debug；场景频谱关掉、保持全 0
    // （`SceneSpectrum.disable`，渲染器之后才建好的在 `ensureRenderer` 里补关）
    // TODO:[WPE_SCENE] 在 macOS / Linux 上测试：场景音频。后端还没有这两个系统的回环采集，这里总被拒、频谱全 0（P11a 的
    // `g_AudioSpectrum*` 也读 0）；后端接上后这里不用改，核对订阅成功、频谱随音乐变化。
    invoke("wpe_web_media_subscribe", { kind: "audio", channel, imageId }).catch((error: unknown) => {
      this.audioError = String(error);
      this.renderer?.disableAudio();
      this.options.report.debug(`场景壁纸 ${imageId} 音频订阅被拒：${this.audioError}`);
    });
  }

  /**
   * 接入系统媒体集成（P11c）：第一次见到 `bundle.media` 时建 `SceneMedia` 与 `MediaPending`、订阅 `kind: "media"`、起刷新计时器；之后什么都不做
   * （重编译保留，订阅只订一次）。计时器间隔取 WPE `config.json` 的 `windowupdaterate`（钳到 50–5000），读不到用 1000 并记一条 debug。
   * 先同步建好对象再等读配置，并发的第二次加载直接返回。
   */
  private async loadMedia(bundle: SceneBundle, sceneAssets: string[]): Promise<void> {
    if (!bundle.media || this.sceneMedia || this.disposed) return;
    this.sceneMedia = new SceneMedia();
    this.mediaPending = new MediaPending({
      log: (message) => this.options.report.debug(`场景壁纸 ${this.options.imageId} ${message}`),
    });
    this.subscribeMedia();
    let rate: unknown;
    try {
      rate = await readWpeWindowUpdateRate(this.reader, sceneAssets);
    } catch {
      rate = undefined;
    }
    if (this.disposed) return;
    const interval = mediaIntervalOf(rate);
    if (interval === null)
      this.options.report.debug(
        `场景壁纸 ${this.options.imageId} 读不到 WPE 的 windowupdaterate，媒体刷新间隔用 ${MEDIA_DEFAULT_INTERVAL_MS} ms`,
      );
    this.mediaInterval = interval ?? MEDIA_DEFAULT_INTERVAL_MS;
    this.mediaTimer = setInterval(() => this.flushMedia(), this.mediaInterval);
  }

  /**
   * 向 `WpeMediaHub` 订阅媒体（后端按调用方文档是场景宿主入口认成场景投影，约定见子计划）。订阅归属宿主 frame，frame 销毁时由 Phase 8 的
   * `SubframeDestroyed` 释放，没有退订命令。收到的消息进 `MediaPending`；被拒（非 Windows 等）时当场把 `{flags: 0x10, enabled: false}`
   * 推进场景队列、不经合并，脚本照 WPE「媒体集成不可用」收到 `{ enabled: false }`，封面槽是缺省纹理。「媒体集成」开关关着不算被拒，
   * 那是后端发 `status { enabled: false }`。
   */
  private subscribeMedia(): void {
    const imageId = this.options.imageId;
    if (this.mediaSubscribed || !imageId) return;
    this.mediaSubscribed = true;
    const channel = new Channel<{ type: string } & Record<string, unknown>>();
    channel.onmessage = (message) => {
      this.recordMediaMessage(message);
      this.mediaPending?.push(message);
    };
    // TODO:[WPE_SCENE] 在 macOS / Linux 上测试：场景媒体集成。后端还没有这两个系统的媒体会话数据源，订阅总被拒（脚本收到 `{ enabled: false }`、
    // 封面槽是缺省纹理）；后端接上后这里不用改，核对标题与封面随播放器变化。
    invoke("wpe_web_media_subscribe", { kind: "media", channel, imageId }).catch((error: unknown) => {
      this.mediaError = String(error);
      this.sceneMedia?.push({
        flags: FLAG_STATUS,
        enabled: false,
        state: 0,
        props: { ...EMPTY_PROPS },
        position: 0,
        duration: 0,
        cover: null,
      });
      this.options.report.debug(`场景壁纸 ${imageId} 媒体订阅被拒：${this.mediaError}`);
    });
  }

  private recordMediaMessage(message: { type: string } & Record<string, unknown>): void {
    const shown =
      message.type === "sceneThumbnail"
        ? { ...message, png: typeof message.png === "string" ? `${message.png.length} 字符 base64` : message.png }
        : message;
    this.mediaMessages.push({ t: performance.now(), message: shown });
    if (this.mediaMessages.length > 20) this.mediaMessages.shift();
  }

  /** 刷新计时器：把待发切成事件推进场景队列；退回预览图期间不派发，事件直接丢掉（位图关掉）。 */
  private flushMedia(): void {
    const pending = this.mediaPending;
    const media = this.sceneMedia;
    if (!pending || !media || this.disposed) return;
    for (const event of pending.flush()) {
      if (this.state === "fallback") closeCover(event.cover);
      else media.push(event);
    }
  }

  /**
   * 每帧取空媒体队列（P11c，脚本阶段最开头）：事件逐条按 WPE 的顺序处理（`media/scene.ts`）。封面先把位图交给来源表（`provide`，当场生效）、
   * 名字当一次属性增量走属性路径；五个回调发给导出了它的全部已 `init` 的脚本。
   */
  private drainMedia(): void {
    const media = this.sceneMedia;
    if (!media?.queued) return;
    media.drain({
      ...scriptMediaCallbacks(this.runtime),
      cover: (name, image, delta) => {
        this.userTextures.provide(name, image);
        this.applyMediaProperties(delta);
      },
    });
  }

  /**
   * 封面换名的属性增量（`$mediaThumbnail` / `$mediaPreviousThumbnail`，只有 `value`、没有 `type`）：并进累计全集后走 `applyChanges`——绑定表命中
   * `user-texture` 就地换图、导出了 `applyUserProperties` 的脚本收到 `{}`（运行时只收同时带 `type` 与 `value` 的项）、`engine.userProperties` 读得到
   * 名字字符串。和 `apply` 不同：没有场景（加载中、退回预览图）时不触发重编译，加载落地后靠 `pendingChanges` 补上。
   */
  private applyMediaProperties(delta: MediaDelta): void {
    const changes = mergeProperties(this.properties, delta as unknown as Record<string, UserProperty>);
    if (!changes.size || this.state !== "ready" || !this.bundle) return;
    this.applyChanges(changes);
  }

  private disposeMedia(): void {
    if (this.mediaTimer !== null) clearInterval(this.mediaTimer);
    this.mediaTimer = null;
    this.mediaPending?.dispose();
    this.mediaPending = null;
    this.sceneMedia?.discard();
    this.sceneMedia = null;
  }

  /**
   * dev 探针（P11c）：媒体订阅状态（`error` 是被拒的原因）、刷新间隔、最近收到的消息（带时间戳）、待发 flags、队列长度与 `SceneMedia` 的当前值；
   * 场景没有接入媒体集成时 `active` 为假。
   */
  media(): {
    active: boolean;
    subscribed: boolean;
    error: string | null;
    intervalMs: number;
    messages: { t: number; message: unknown }[];
    pendingFlags: number;
    scene: SceneMediaSnapshot | null;
  } {
    return {
      active: this.sceneMedia !== null,
      subscribed: this.mediaSubscribed && this.mediaError === null,
      error: this.mediaError,
      intervalMs: this.mediaInterval,
      messages: this.mediaMessages.map((item) => ({ ...item })),
      pendingFlags: this.mediaPending?.pendingFlags ?? 0,
      scene: this.sceneMedia?.snapshot() ?? null,
    };
  }

  /**
   * 建脚本环境。并发的重载要排队：不排队会建出第二个 realm、`init` 跑两次，`localStorage` 的写入也跟着多一次。
   * 等完再判断：在途的那次可能已被「清空脚本存储」作废，这时要重建。
   */
  private async ensureRuntime(bundle: SceneBundle, sceneAssets: string[]): Promise<void> {
    while (this.runtimeTask) await this.runtimeTask;
    if (this.runtime || this.scriptUnavailable || !bundle.scripts.list.length) return;
    this.runtimeTask = this.startRuntime(bundle, sceneAssets).finally(() => {
      this.runtimeTask = null;
    });
    await this.runtimeTask;
  }

  /**
   * 脚本读 `engine.screenResolution`：首次加载的 `init` 早于建渲染器（原先这时退回画布元素的缺省 300×150），那时按渲染器的同一规则（布局 × DPR，
   * `canvasSize` 显示缩放 1；设备纹理上限还不知道，不钳）量一次记下（`seed`，只在从没量过时），渲染器建好后量到的不同就调 `resizeScreen`。
   */
  private scriptScreenResolution(): [number, number] {
    if (!this.renderer) {
      const rect = this.canvas.getBoundingClientRect();
      const full = canvasSize(rect.width, rect.height, window.devicePixelRatio || 1, 1, Number.POSITIVE_INFINITY);
      this.screen.seed(full.width, full.height);
    }
    return this.screen.current;
  }

  private async startRuntime(bundle: SceneBundle, sceneAssets: string[]): Promise<void> {
    try {
      // 场景键取地址参数 kbScene（3c 已定 7）：没有图片 id 时只存在内存里，不读写持久存储。
      const imageId = this.options.imageId;
      const backend = imageId ? browserStorage() : null;
      const realm = await createIframeRealm({
        document,
        scripts: bundle.scripts,
        sceneAssets,
        modules: getJsModuleIndex(sceneAssets),
        console: { log: (message) => console.log(message), error: (message) => this.scriptConsoleError(message) },
        localStorage: (global) =>
          createWpeLocalStorage({
            global,
            backend,
            sceneKey: imageId ?? "memory",
            isEvaluating: () => this.scriptApi?.moduleEvaluating ?? false,
            debug: (message) => this.options.report.debug(message),
          }),
      });
      if (this.disposed) {
        realm.dispose();
        return;
      }
      // 脚本模型数据仓（P14）：结构变了（`replaceData`）时宿主重拼用它的图层
      const modelData = new ModelDataStore();
      modelData.onStructure = (token) => this.onModelDataStructure(token);
      this.modelData = modelData;
      const api = new ScriptApi(realm, {
        modelData,
        materialCheck: (material, format) => this.materialCheck(material, format),
        bundle: () => this.scriptBundle!,
        state: () => this.scriptState!,
        // 按显示缩放为 1 算：预览缩小显示时画布变小，脚本看到的分辨率仍与桌面一致
        screenResolution: () => this.scriptScreenResolution(),
        frametime: () => this.renderer?.frameSeconds ?? 0,
        runtime: () => this.renderer?.runtimeSeconds ?? 0,
        timeOfDay: () => daytimeOf(new Date()),
        write: (target, value) => {
          const applied = this.writeScript(target, value);
          if (applied) this.runtime?.rememberWrite(target, value);
          return applied;
        },
        read: (target) => this.readScript(target),
        audioRegistered: () => this.subscribeAudio(),
        // 声音层的 play / pause / stop / isPlaying（P6a 步骤 2）：每次调用现取，重编译重建的排期器也接得上
        sound: (object) => this.sceneSounds?.scheduler(object) ?? null,
        // 视频纹理的 IVideoTexture（P9b）：按脚本当前看到的 bundle 找图层槽 0 的视频，再按区间键取播放器。`loadVideos` 在新场景换上之前
        // 就按新 bundle 重建了下标表，这期间脚本还在用旧 bundle，下标对不上、区间键照样对得上
        video: (object) => {
          const source = layerVideoSource(this.scriptBundle, object);
          return source ? (this.sceneVideos?.playerFor(source) ?? null) : null;
        },
        // ITextureAnimation 未脱离时读 / 脱离时拷共享计时器（P6e 点 3）：渲染器画完上一帧后的值
        sheetClock: (texture) => this.renderer?.sheetClock(texture),
        // 粒子层的 play / pause / stop / isPlaying / emitParticles（P4f 步骤 3）：同样每次现取
        particles: (object) => this.particleTarget(object),
        // getTransformMatrix（P6d1a）：有渲染器场景时用它的挂点钩子现算，否则（首次加载的 init）api 退回纯状态现算
        transformMatrix: (object) => {
          const renderer = this.renderer;
          const state = renderer?.sceneState;
          return renderer && state ? renderer.transformMatrix(object, state) : null;
        },
        // 挂点钩子与运行中结构（P6d3a）：`setParent` 的 adjust 数学与挂点名读它们，换父成功后经 `reparented` 记进结构
        attachPose: (object) => this.renderer?.attachMatrix(object) ?? null,
        structure: () => this.structure,
        reparented: (change) => this.onReparented(change),
        // `createLayer`（P6d3b）：当前脚本的 `__workshopId` 取自运行时；建层与新对象上的脚本经宿主落到状态与运行时
        workshopId: () => this.runtime?.currentWorkshopId() ?? null,
        createLayer: (config, parent) => this.onCreateLayer(config, parent),
        addScripts: (scripts) => this.runtime?.addScripts(scripts),
        warn: (message) => this.options.report.warn(message),
        // 全局 `input`（P6c）：每次读都取渲染器最近一帧给的光标快照
        cursorInput: () => this.cursorInput,
        // 快捷方式（P11d）：回调名取自运行时，令牌与属性检查在 `openUserShortcut`
        activeCallback: () => this.runtime?.activeCallback ?? null,
        openUserShortcut: (name) => this.openUserShortcut(name),
        // 关键帧动画的 IAnimation（P10b）：待用播放器属于脚本当前看到的 bundle 时取它（首次加载的 init），否则取正在播的那份；每次现取，
        // 重编译换了播放器也接得上
        animation: (id) => {
          const pending = this.pendingAnimations;
          const player = pending && pending.bundle === this.scriptBundle ? pending.player : this.sceneAnimations;
          return player?.control(id) ?? null;
        },
        // puppet 动画层（P12c）：同上，待用运行时属于脚本当前看到的 bundle 时取它（首次加载的 init），否则取正在播的那份；每次现取
        puppetLayers: (object) => {
          const pending = this.pendingPuppets;
          const puppets = pending && pending.bundle === this.scriptBundle ? pending.puppets : this.scenePuppets;
          return puppets
            ? {
                ids: () => puppets.ids(object),
                find: (name) => puppets.findLayer(object, name),
                control: (id) => puppets.control(object, id),
                alive: (id) => puppets.alive(object, id),
                // 运行时建删层（P12e）：动画表取运行时的 rig，建出来的层由 `settle` / 派发里的 `released` 钩子善后
                animations: () => puppets.rig(object)?.animations ?? [],
                create: (item, single) => puppets.createLayer(object, item, single),
                destroy: (selector) => puppets.destroyLayers(object, selector),
                // 骨骼脚本方法（P12d-2）
                boneTransform: (bone) => puppets.boneTransform(object, bone),
                setBoneTransform: (bone, matrix) => puppets.setBoneTransform(object, bone, matrix),
                applyBonePhysicsImpulse: (bone, dir, ang) => puppets.applyBonePhysicsImpulse(object, bone, dir, ang),
                resetBonePhysicsSimulation: (bone) => puppets.resetBonePhysicsSimulation(object, bone),
                // 局部骨骼读写（P12g）
                localBoneTransform: (bone) => puppets.localBoneTransform(object, bone),
                localBoneAngles: (bone) => puppets.localBoneAngles(object, bone),
                localBoneOrigin: (bone) => puppets.localBoneOrigin(object, bone),
                setLocalBoneTransform: (bone, matrix) => puppets.setLocalBoneTransform(object, bone, matrix),
                setLocalBoneAngles: (bone, v) => puppets.setLocalBoneAngles(object, bone, v),
                setLocalBoneOrigin: (bone, v) => puppets.setLocalBoneOrigin(object, bone, v),
              }
            : null;
        },
      });
      const runtime = new ScriptRuntime(realm, {
        report: this.options.report,
        write: (target, value) => this.writeScript(target, value),
        read: (target) => this.readScript(target),
        enterScript: (script) => api.enterScript(script),
        setProperties: (full) => api.setProperties(full),
        setModuleEvaluating: (evaluating) => api.setModuleEvaluating(evaluating),
      });
      api.attachRuntime(runtime);
      // WPE 的 `init` 里 `engine.userProperties` 已是全集（含内置项，I4 与 `p3am-builtin` 实测）：求值、`init` 之前就交给 API
      api.setProperties(this.properties);
      this.scriptApi = api;
      this.runtime = runtime;
      // `init` 之后、首次 `applyUserProperties` 之前，按场景媒体状态给刚 `init` 的脚本补一轮媒体回调（P11c，rea-p11-media 2.5）
      await runtime.load(bundle.scripts, () => this.sceneMedia?.replayAfterInit(scriptMediaCallbacks(runtime)));
    } catch (error) {
      this.scriptUnavailable = true;
      this.options.report.error(`场景脚本 baseclasses.js 或 realm 加载失败：${String(error)}`);
    }
  }

  /** dev 探针：当前 bundle 与渲染器（生产构建不访问）。 */
  get devScene(): { bundle: SceneBundle | null; renderer: SceneRenderer | null } {
    return { bundle: this.bundle, renderer: this.renderer };
  }

  /** dev 探针：每段脚本的诊断；`recompileWrites` 合并回调返回值与 API 直接写入两路。 */
  get scriptDiagnostics(): unknown[] {
    return scriptDiagnostics(this.runtime, this.scriptApi?.recompileWrites);
  }

  /** dev 探针：运行秒数、本帧 dt 与脚本计时器（所属段、剩余秒数、周期）。 */
  clock(): {
    runtimeSeconds: number;
    frameSeconds: number;
    timers: { script: string; remaining: number; period: number | null }[];
  } {
    return {
      runtimeSeconds: this.renderer?.runtimeSeconds ?? 0,
      frameSeconds: this.renderer?.frameSeconds ?? 0,
      timers: this.runtime?.timerInfo ?? [],
    };
  }

  /**
   * dev 探针：音频是否已订阅（`error` 是被拒的原因）、收到的帧数、已注册的分辨率与最近一帧原值的峰值；`spectrum16` 是渲染器场景频谱
   * 归一化后的 16 段（P4e 步骤 4，粒子读的就是它，和 WPE 抓帧的 `g_AudioSpectrum16Left/Right` 比），没有渲染器时为 null；`raw` 是最近一帧
   * Hub 的原值（左 64 + 右 64，WPE 采集线程的输出，没收到时为 null），核对原始频谱的量级用。
   */
  audio(): {
    subscribed: boolean;
    error: string | null;
    frames: number;
    resolutions: number[];
    peak: number;
    raw: number[] | null;
    spectrum16: { left: number[]; right: number[] } | null;
  } {
    const spectrum = this.renderer?.spectrum;
    return {
      subscribed: this.audioSubscribed && this.audioError === null,
      error: this.audioError,
      frames: this.audioFrames,
      resolutions: this.scriptApi?.audioResolutions ?? [],
      peak: this.lastAudioFrame ? Math.max(...this.lastAudioFrame) : 0,
      raw: this.lastAudioFrame ? [...this.lastAudioFrame] : null,
      spectrum16: spectrum ? { left: [...spectrum.L16], right: [...spectrum.R16] } : null,
    };
  }

  readTarget(path: string): unknown {
    const state = this.renderer?.sceneState;
    const bundle = this.bundle;
    if (!state || !bundle) return null;
    if (path === "general/bloom") return state.bloomEnabled;
    if (path.startsWith("general/bloom/"))
      return state.bloom[path.slice("general/bloom/".length) as keyof SceneState["bloom"]] ?? null;
    if (path.startsWith("general/")) return state.general[path.slice("general/".length) as GeneralKey] ?? null;
    const layer = /^objects\/(\d+)\/(origin|scale|angles|alpha|color|brightness|visible|parallaxDepth)$/.exec(path);
    if (layer)
      return state.layers.get(Number(layer[1]))?.[layer[2] as keyof import("./render/state").LayerState] ?? null;
    // 声音的 `volume`（P6a 步骤 1）：状态里的值，排期器下一帧（或改值时当场）读到的就是它
    const sound = /^objects\/(\d+)\/(volume|mintime|maxtime)$/.exec(path);
    if (sound) return state.sounds.get(Number(sound[1]))?.[sound[2] as keyof SoundValues] ?? null;
    // 粒子 `instanceoverride` 的就地值（P4a 步骤 5）：状态里的值，与模拟器正在用的相同；控制点（P4f 步骤 3）按键取那一项，没设为 null
    const instance = /^objects\/(\d+)\/instanceoverride\/(\w+)$/.exec(path);
    if (instance) {
      const values = state.particleInstances.get(Number(instance[1]));
      const point = instanceControlPoint(instance[2]);
      if (point) return (point.angle ? values?.controlpointAngles : values?.controlpoints)?.[point.index] ?? null;
      return values?.[instance[2] as InstanceField | "colorn"] ?? null;
    }
    const constant = /^(objects\/\d+(?:\/effects\/\d+)?\/passes\/\d+)\/constantshadervalues\/(.+)$/.exec(path);
    if (constant) {
      const target = bundle.bindings.find(
        (binding) => binding.target.kind === "constant" && this.targetPath(binding.target) === path,
      )?.target;
      if (target?.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
      const script = bundle.scripts.list.find((item) => item.id === path);
      if (script?.target.kind === "constant") return this.readScript(script.target);
    }
    return null;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.renderer?.setPaused(paused);
    this.syncSoundGlobal();
    // 视频纹理（P9a）：宿主暂停时全部 pause，恢复时全部放（rea-p9-video 第 3 节第 5 条）
    this.sceneVideos?.setPaused(this.paused || this.hidden);
    this.userTextures.setPaused(this.paused || this.hidden);
  }

  /**
   * 宿主音量 h（0…1，垫片交来：桌面与预览是壁纸音量，应用背景与暂停时为 0）。声音的排期器把它当 WPE 的全局音量 G：
   * 从正变 0 暂停在放的（`single` / `random` 已放完的停掉），从 0 变正续播、从没开始过的从头开始（P6a 步骤 1）。
   */
  setHostVolume(volume: number): void {
    this.hostVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
    this.syncSoundGlobal();
  }

  /**
   * 垫片的 `applyGeneralProperties(general)`（加载后一次、之后 `general` 变了才调）：只取帧率。`general.fps` 是有限正数时取整存下
   * 并交给渲染器就地生效（不重新加载）；别的值忽略、保持当前帧率。不走父页面的 `kabegame:wpe-scene-settings`（那条只管要重载的四项）。
   */
  setGeneral(general: unknown): void {
    if (this.disposed || !general || typeof general !== "object") return;
    const raw = (general as { fps?: unknown }).fps;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return;
    const fps = Math.max(1, Math.round(raw));
    if (fps === this.fps) return;
    this.fps = fps;
    this.renderer?.setMaxFps(fps);
  }

  /**
   * 播放速度（父页面的 `kabegame:wpe-scene-rate`：壁纸设置「倍速」与预览控制条，0.2–4）：渲染器的帧时间、视频纹理的时钟、声音元素一起换，
   * 不重新加载。不是有限正数的忽略，越界的钳进范围。
   */
  setPlaybackRate(rate: number): void {
    if (this.disposed || !Number.isFinite(rate) || rate <= 0) return;
    const clamped = Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, rate));
    if (clamped === this.playbackRate) return;
    this.playbackRate = clamped;
    this.renderer?.setPlaybackRate(clamped);
    this.sceneVideos?.setHostRate(clamped);
    this.soundPlayer?.setRate(clamped);
  }

  /** 文档隐藏时渲染循环停转、声音的计时冻结，声音也按暂停处理（不然多文件、`random` 会在放完之后断掉）。 */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.syncSoundGlobal();
    // 视频纹理同样按暂停处理：循环停了帧号不走，不停的话视频会在后台一直放
    this.sceneVideos?.setPaused(this.paused || this.hidden);
    this.userTextures.setPaused(this.paused || this.hidden);
  }

  /** 排期器看到的全局音量：暂停或隐藏时为 0，否则是宿主音量；暂停 / 恢复另交给播放器淡变。 */
  private syncSoundGlobal(): void {
    const active = !this.paused && !this.hidden;
    this.sceneSounds?.setGlobal(active ? this.hostVolume : 0, active);
  }

  private soundVolumeOf = (object: number): number | undefined => this.renderer?.sceneState?.sounds.get(object)?.volume;

  /**
   * 渲染器正在画的那份状态（没有渲染器时退回 `scriptState`）：关键帧动画写这里。平时它就是 `scriptState`；只在重建脚本环境（「清空脚本
   * 存储」）的加载期间不同：那时 `scriptState` 是给新脚本 `init` 用的新状态，旧场景与旧动画还在画，写进新状态会让 `init(value)` 收到
   * 动画值（WPE 收到的是 `value`，rea-p10-keyframes 第 4 节），旧场景的动画也会停住。
   */
  private get drawnState(): SceneState | null {
    return this.renderer?.sceneState ?? this.scriptState;
  }

  /**
   * 关键帧写了声音对象的 `volume`（P10a 步骤 3）：当场交给排期器，同 `writeScript`（WPE 的 setter 写值时当场调回调 `V`）。排期器的
   * 每帧步进在 `beforeFrame` 之前，不推的话晚一帧。读的是动画写进的那份状态（`drawnState`，换场景时渲染器已先换好）。
   */
  private readonly pushSoundVolume = (object: number): void => {
    const volume = this.drawnState?.sounds.get(object)?.volume;
    if (volume !== undefined) this.sceneSounds?.scheduler(object)?.setVolume(volume);
  };

  /**
   * 一个动画层被释放（P12e：单次层在派发里被删、或 `settle` 释放 destroyAnimationLayer 摘出的层）：删状态里三方共写的字段（渲染器正在画的与脚本看的
   * 两份），再让脚本运行时给它的字段脚本发 `destroy`、清重放表里它的项。之后包装作废（`alive` 为假）。
   */
  private readonly puppetReleased = (object: number, id: number): void => {
    this.drawnState?.removeAnimationLayer(object, id);
    if (this.scriptState !== this.drawnState) this.scriptState?.removeAnimationLayer(object, id);
    this.runtime?.destroyAnimationLayer(object, id);
  };

  private syncSoundVolumes(): void {
    this.sceneSounds?.syncVolumes(this.soundVolumeOf);
  }

  /**
   * 运行中重排缺的字体读完了（P6b 1e，`SceneTexts` 的 `onReady`，只在发起重排的那次加载仍是最新时到达）：把那一层重新标脏，下一次 `sync`
   * 再排。暂停时循环不跑，补画一帧（同属性就地写）。场景已经换成没有这一层的时，`touchText` 不做事。
   */
  private onTextReady(object: number): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    const state = renderer?.sceneState;
    if (!renderer || !state) return;
    state.touchText(object);
    if (this.paused) renderer.redraw();
  }

  /**
   * 用户纹理的一个来源解码完成（或值清空 / 读不出回到缺省，P11b 步骤 2，`UserTextureSources.onReady`）：把它标进渲染器正在画的那份状态，
   * 下一次 `sync` 换上；暂停时循环不跑，补画一帧（同属性就地写）。没有渲染器 / 状态时（加载期间、退回预览图）不做事：加载由 `primeUserTextures` 等。
   */
  private onUserTextureReady(name: string): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    const state = renderer?.sceneState;
    if (!renderer || !state) return;
    state.touchUserTexture(name);
    if (this.paused) renderer.redraw();
  }

  /**
   * 加载时对 bundle 的属性来源按当前属性值预先解码，全部完成（或失败、回缺省）才建场景，第一帧就是用户图（P11b 步骤 2）。值只认字符串，别的
   * 类型（`slider` 之类）当空串（缺省纹理）。没有用户纹理的 bundle 不碰来源表。封面来源（P11c）不在这里（媒体模块交图），快捷方式（P11d）的值是键、图标经 `shortcutIcon` 取。
   */
  private primeUserTextures(bundle: SceneBundle): Promise<boolean> {
    // 手写的测试 bundle 可能没有这个表
    return this.primeUserTextureSources(bundle.userTextures ?? []);
  }

  /**
   * 按来源列表预解码（L3b：运行中接入对象带来的新来源也走它）。封面来源（P11c）由媒体模块经 `provide` 交图，不在这里。
   * 快捷方式（P11d）的值是后端给的键、图标经 `shortcutIcon` 取。
   */
  private async primeUserTextureSources(list: readonly UserTextureSource[]): Promise<boolean> {
    const sources = list.filter((source) => source.kind !== "system");
    if (!sources.length) return true;
    const limit = this.options.userTexturePrimeTimeoutMs ?? USER_TEXTURE_PRIME_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = this.userTextures
      .prime(
        sources.map((source) => {
          const value = this.properties.get(source.name)?.value;
          return [source.name, typeof value === "string" ? value : "", source.kind] as const;
        }),
      )
      .then(() => true);
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), limit);
    });
    const finished = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (!finished)
      this.options.report.warn(
        `场景壁纸 ${this.options.imageId} 的用户纹理 ${limit} ms 内没解码完，先用缺省纹理建场景，解码完成后换上`,
      );
    return finished;
  }

  /** 向后端要快捷方式的图标（P11d）：没有图片 id、没配、取不到、非 Windows 都是 null；失败抛错（来源表记成失败，用缺省纹理）。 */
  private async fetchShortcutIcon(name: string): Promise<ShortcutIcon | null> {
    const imageId = this.options.imageId;
    if (!imageId) return null;
    return parseShortcutIcon(await invoke<ArrayBuffer>("wpe_scene_shortcut_icon", { imageId, name }));
  }

  /**
   * `engine.openUserShortcut` 的宿主一侧（P11d，WPE 宿主的三种返回）：先取点击令牌（没有 → 2，调用方抛错；令牌在查属性之前就消耗，同 WPE），再查属性全集：
   * `type === "usershortcut"` 且 `isbound === true` 时把属性名 `postMessage` 给父页面（`shortcut/message.ts`，真正启动由应用页核对用户激活后调
   * `wpe_open_user_shortcut`）并返回 1，否则 0。这里的门禁只约束守规矩的脚本（脚本 realm 同源、能拿到 `parent`），安全边界在应用页与后端。
   *
   * 非 Windows：后端给的 `isbound` 一律为 false，这里恒返回 0。TODO:[WPE_SCENE] macOS / Linux 的快捷方式（本机测不了）。
   */
  private openUserShortcut(name: string): 0 | 1 | 2 {
    if (!this.shortcutToken.take()) return 2;
    const property = this.properties.get(name);
    if (property?.type !== "usershortcut" || property.isbound !== true) return 0;
    const post = this.options.postToParent ?? ((message: unknown) => window.parent.postMessage(message, "*"));
    post(shortcutRequest(name));
    return 1;
  }

  /** dev 探针（P11b 步骤 2）：每个用户纹理属性来源的当前值、状态、尺寸与最近一次解码用时；没有来源时为空。 */
  userTextureProbe(): UserTextureProbe[] {
    return this.userTextures.probe();
  }

  /** dev 探针与确定性回放：等全部用户纹理解码结束（成功、失败或被取代）。 */
  settleUserTextures(): Promise<void> {
    return this.userTextures.settled();
  }

  /**
   * 换上 bundle 的声音表：没有声音的场景不建播放器。宿主收到 bundle 就开始，不等 GPU 资源（WPE 加载时就开始放，不等第一帧）。
   * 同一对象的排期器跨重编译保留（`SceneSounds.load`）。
   */
  private loadSounds(bundle: SceneBundle): void {
    // 手写的测试 bundle 可能没有声音表
    const sounds = bundle.sounds ?? [];
    if (!sounds.length && !this.sceneSounds) return;
    if (!this.sceneSounds) {
      const imageId = this.options.imageId;
      this.soundPlayer = new ScenePlayer({ reader: this.reader }, this.options.report);
      if (this.playbackRate !== 1) this.soundPlayer.setRate(this.playbackRate);
      this.sceneSounds = new SceneSounds(
        this.soundPlayer,
        Math.random,
        (object, file, error) =>
          this.options.report.warn(
            `场景壁纸 ${imageId} 声音对象 ${object} 的文件读不出，已从列表删掉：${file.path}`,
            error,
          ),
        // mintime / maxtime 现读绘制状态（同 pushSoundVolume 的来源）
        (object) => this.drawnState?.sounds.get(object),
      );
      this.syncSoundGlobal();
    }
    this.sceneSounds.load(sounds);
  }

  private disposeSounds(): void {
    this.sceneSounds?.dispose();
    this.sceneSounds = null;
    this.soundPlayer = null;
  }

  /**
   * 换上 bundle 的视频纹理（P9a 步骤 2）：没有视频纹理的场景不建 `SceneVideos`。宿主收到 bundle 就开始读、开始放，不等 GPU 资源
   * （WPE 建纹理时 `SetTarget` 就起工作线程，rea-p9-video 第 2 节第 2 条）。同一区间的播放器跨重编译复用（决定 2）。
   */
  private loadVideos(bundle: SceneBundle): void {
    // 手写的测试 bundle 可能没有纹理表
    const textures = bundle.textures ?? [];
    if (!this.sceneVideos && !textures.some((texture) => texture.video)) return;
    if (!this.sceneVideos) {
      this.sceneVideos = new SceneVideos(this.options.report);
      // 先定暂停再建播放器：暂停中加载的场景，新播放器一开始就不放
      this.sceneVideos.setPaused(this.paused || this.hidden);
      if (this.playbackRate !== 1) this.sceneVideos.setHostRate(this.playbackRate);
    }
    this.sceneVideos.load(textures);
    this.videoBundle = bundle;
  }

  private disposeVideos(): void {
    this.sceneVideos?.dispose();
    this.sceneVideos = null;
    this.videoBundle = null;
    this.drawingBundle = null;
  }

  /** dev 探针（P9a）：每段视频的位置、`currentTime`、`paused`、`lastDrawn`、`fresh`、`failed`、尺寸与丢帧数；没有视频时为空。 */
  videos(): SceneVideoProbe[] {
    return this.sceneVideos?.probe() ?? [];
  }

  /**
   * dev 探针（P4j 步骤 2b）：`layerimage` 发射器候选表的每条记录——`id`、`mask`、状态（0 待渲染 / 1 待读回 / 2 有表）、是否过了门与过门的帧号、
   * 建表时的合成 RT 尺寸、降采样尺寸 `w4 × h4`、表项数；`includeEntries` 时另带全部表项 `[x, y, r, g, b]`（和 `ignore/p4/j0/model.py` 的预测逐项比）。
   * 场景没有发射图依赖（或还没加载）时为空表。
   */
  emitterImages(options: { includeEntries?: boolean } = {}): EmitterImageProbe[] {
    return this.renderer?.currentScene?.emitterImageRecords(options.includeEntries ?? false) ?? [];
  }

  /**
   * dev 探针（P10a 步骤 3）：每条关键帧动画的 `id`、时钟主人、`t`、`getFrame()`、`isPlaying()`、标志、最后写入的值，以及最近 600 帧
   * `frame()` 的耗时；没有场景（还没加载、退回预览图）时为空表。
   */
  animations(): AnimationsProbe {
    return this.sceneAnimations?.probe() ?? EMPTY_ANIMATIONS_PROBE;
  }

  /**
   * dev 探针（P12c）：正在播的 puppet 运行时（还没换上时取待用的那份）里每个对象每个动画层的名字、帧号、是否在播；`pending` 为真表示取的是待用的。
   * 用来在不跑帧循环的屏外宿主里看 `init` 对动画层的控制有没有落到运行时上。
   */
  puppetProbe(): {
    pending: boolean;
    objects: {
      object: number;
      /** 摘出（destroyAnimationLayer）还没释放的层数（P12e：看「摘了还没 settle」）。 */
      detached: number;
      layers: { id: number; name: string; frame: number; playing: boolean }[];
      /**
       * 绘制顺序（P12f，`ScenePuppets.drawOrder`；不会重排也没有裁切的对象为 null）：`version` 每次真的重排 +1；`commands` 是当前裁切命令表（没有记录为 null；
       * normal 带段号，clip 带记录号与遮罩 / 目标段号）；`segments` 是命令表各段的索引个数；`indices` 是按当前顺序拼的整张网格 u16 索引
       * （没重排过是文件顺序）。走查时按帧与 WPE 抓帧的索引顺序（`get_mesh_data`）逐个对。
       */
      drawOrder: {
        version: number;
        commands:
          | ({ kind: "normal"; segment: number } | { kind: "clip"; record: number; mask: number; target: number })[]
          | null;
        segments: number[] | null;
        indices: number[];
      } | null;
    }[];
  } {
    const pending = !this.scenePuppets && !!this.pendingPuppets;
    const puppets = this.scenePuppets ?? this.pendingPuppets?.puppets ?? null;
    const bundle = this.drawingBundle ?? this.pendingPuppets?.bundle ?? null;
    if (!puppets || !bundle) return { pending, objects: [] };
    const objects = bundle.layers
      .map((layer) => layer.object)
      .filter((object) => puppets.layerCount(object) > 0 || puppets.drawOrder(object))
      .map((object) => ({
        object,
        detached: puppets.detachedCount(object),
        drawOrder: (() => {
          const order = puppets.drawOrder(object);
          if (!order) return null;
          return {
            version: order.version,
            commands: order.clipping ? order.clipping.commands.map((command) => ({ ...command })) : null,
            segments: order.clipping ? order.clipping.segments.map((segment) => segment.length) : null,
            indices: Array.from(order.indices),
          };
        })(),
        layers: puppets.ids(object).map((id) => {
          const control = puppets.control(object, id)!;
          return { id, name: control.name, frame: control.getFrame(), playing: control.isPlaying() };
        }),
      }));
    return { pending, objects };
  }

  /** dev 探针：每个声音对象的模式、当前文件、实例状态、`T`、`Rm`、`isPlaying`、增益，以及播放器的元素与 context。 */
  sounds(): {
    hostVolume: number;
    paused: boolean;
    hidden: boolean;
    sounds: SceneSoundProbe[];
    player: ReturnType<ScenePlayer["probe"]> | null;
  } {
    return {
      hostVolume: this.hostVolume,
      paused: this.paused,
      hidden: this.hidden,
      sounds: this.sceneSounds?.probe() ?? [],
      player: this.soundPlayer?.probe() ?? null,
    };
  }

  setPointer(x: number, y: number): void {
    this.pointer = [x, y];
    this.renderer?.setPointer(x, y);
  }

  /**
   * 左键按下 / 抬起（P6c，`main.ts` 的 `pointerdown` / `pointerup`，桌面是鼠标转发注入的）：渲染器每个实时帧采一次（一帧里完整的按下抬起会丢，
   * 同 WPE）。桌面的按下门（只在光标下是桌面或图标时转发）由后端的鼠标转发负责，这里不另加。
   */
  setButton(down: boolean): void {
    this.button = down;
    this.renderer?.setButton(down);
  }

  setStyle(style: SceneStyle): void {
    this.style = style;
    this.renderer?.setStyle(style);
    // 内置属性 `alignment` 跟着样式走（`wpeAlignmentOf`，工程自己声明了的不动），作为一条增量走应用函数（值没变时去重掉）；
    // 首包之前只记下样式，补内置项时取
    // TODO:[WPE_SCENE] 没实测：WPE 里运行中改对齐时脚本收不收到 `applyUserProperties({ alignment })`（推断收到：同 UI 改属性的增量）
    if (this.receivedProperties && this.hostBuiltins.has("alignment"))
      this.apply({ alignment: { type: WPE_BUILTIN_PROPERTIES.alignment.type, value: wpeAlignmentOf(style) } });
  }

  setDisplayScale(scale: number): void {
    this.displayScale = scale;
    this.renderer?.setDisplayScale(scale);
  }

  private dropRenderer(): void {
    this.rendererTask = null;
    this.renderer?.destroy();
    this.renderer = null;
  }

  private ensureRenderer(): Promise<SceneRenderer> {
    if (this.rendererTask) return this.rendererTask;
    const displayScale = this.displayScale;
    const fps = this.fps;
    const task: Promise<SceneRenderer> = SceneRenderer.create(this.canvas, {
      // 帧率（`setGeneral`）：首次建与设备丢失后重建都取当前值；取设备期间又变了的在建好后补设
      maxFps: fps,
      displayScale,
      // 场景频谱的输入（P4e 步骤 4）：Hub 最近一次的原值，渲染器每帧开头取一次
      audioFrame: () => this.lastAudioFrame,
      stepObjects: (dt) => this.sceneSounds?.step(dt, this.soundVolumeOf),
      // 光标交互（P6c）：有脚本导出光标回调才命中；回调交给脚本运行时（同一对象上导出了它的全部脚本）
      cursor: {
        active: () => this.state !== "fallback" && (this.runtime?.hasCursorCallbacks ?? false),
        input: (snapshot) => {
          this.cursorInput = snapshot;
          // 快捷方式的点击令牌（P11d）：左键按下沿在本帧派发之前发（渲染器先 `input`、再 `events`、最后 `end`）
          this.shortcutToken.beginFrame(snapshot.leftDown);
        },
        events: (dispatches) => {
          for (const item of dispatches) this.runtime?.cursorEvent(item.object, item.callback, item.world, item.local);
        },
        // 松开沿在本帧派发之后收（没有派发的帧也要调，所以不放在 `events` 里）
        end: (snapshot) => this.shortcutToken.endFrame(snapshot.leftDown),
      },
      // puppet（P12a 步骤 4）：用户属性写进状态后这一帧就读到（读的是渲染器正在画的那份状态）
      stepPuppets: (dt) => {
        const drawn = this.drawnState;
        // 事件（MDLA）与播完回调在每个 puppet 推进完之后派发（P12c）：事件交给脚本运行时的 `animationEvent`，回调里的写入下一帧生效
        if (drawn)
          this.scenePuppets?.frame(dt, stateSink(drawn), {
            event: (object, json) => this.runtime?.animationEvent(object, json),
            released: this.puppetReleased,
          });
      },
      videos: this.videoSink,
      // 脱离的纹理动画图层画自己的帧（P6e 点 3）：读渲染器正在画的那份状态，没有条目或没脱离时 −1（走共享计时器）
      sheetOverride: (object) => textureAnimationOverride(this.drawnState?.textureAnimations.get(object)),
      beforeFrame: (dt, spectrum) => {
        // 脚本的音频缓冲改读归一化频谱（P4e 步骤 4，「决定」5）：渲染器这一帧推进之后、脚本之前拷一次
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) {
          // 变更队列（L5）：异步编好 / 备好的对象在脚本阶段最开头装上（媒体、动画、脚本都读得到它）
          this.live?.drain();
          // 系统媒体事件（P11c）：脚本阶段最开头，光标派发（渲染器 `stepCursor`）之后、动画之前（rea-p11-media 2.3、2.4）。没有脚本的场景也跑
          // （只有封面纹理）：封面增量照走属性路径、换图同帧画出，回调只在有脚本运行时才调
          this.drainMedia();
          // 关键帧动画（P10a 步骤 3）先于脚本写（rea-p10-keyframes 第 1、9 节）：脚本 `update(value)` 收到的是本帧的动画值，脚本写回
          // 只活到下一帧动画覆盖。不受脚本运行时门控：没有脚本的场景也跑（`scriptState` 在换场景时总会设上）。
          // 写进渲染器正在画的那份状态（`drawnState`），它和这份动画同时换（`beforeFirstFrame`）；平时就是 `scriptState`
          const drawn = this.drawnState;
          // 动画事件（P10b）：越过事件的那一条写完就同步派发给脚本，在 `runtime.frame`（update）之前；返回值写回同 update
          if (drawn)
            this.sceneAnimations?.frame(dt, drawn, {
              sound: this.pushSoundVolume,
              event: ({ object, json }) => this.runtime?.animationEvent(object, json),
            });
          this.runtime?.frame(dt);
          // 删除生效（P6d3a，rea-p6d-layers 4.2 第 7.5 步）：全部脚本之后、绘制之前
          settleDestroyed(this.scriptState, {
            runtime: this.runtime,
            removed: (objects) => this.onDestroyed(objects),
          });
          // destroyAnimationLayer 摘出的层在这里释放（P12e，WPE 先处理待删对象、再尾调排空 `ctx+0x1478`）：包装作废、字段脚本收 destroy
          this.scenePuppets?.settle({ released: this.puppetReleased });
          // 结构变化（L7）：这一帧的换父、删除、接进的对象改了组与挂点的，渲染器在绘制之前当帧重排（先释放被删对象），出错整场重载
          this.flushRestructure();
        }
      },
      onError: (reasons) => {
        if (this.rendererTask === task) this.fallback(reasons);
      },
      onLost: (reasons) => {
        if (this.rendererTask !== task) return;
        this.dropRenderer();
        const now = performance.now();
        if (now - this.lastLostAt < LOST_RETRY_WINDOW_MS) {
          this.fallback(reasons);
          return;
        }
        this.lastLostAt = now;
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 设备丢失，重建渲染器：`, reasons);
        void this.reload();
      },
      // 画布分辨率、样式、留白色变了都由渲染器原地换尺寸（`GpuScene.resize`），只有换尺寸中途失败（场景已是新尺寸、部分图层仍是旧 draw）才整场重新加载兜底，
      // bundle 与尺寸无关、编译结果相同，脚本写入照常重放
      onResizeFailed: (reasons) => {
        if (this.rendererTask !== task) return;
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 原地换尺寸失败，整场重新加载：`, reasons);
        void this.reload();
      },
      // 脚本的 `engine.screenResolution`：宿主这一份交给渲染器量，变了调脚本的 `resizeScreen`（见 `screen`）
      screenResolution: this.screen,
    }).then(
      (created) => {
        if (this.rendererTask !== task || this.disposed) {
          created.destroy();
          throw new DOMException("渲染器已过期", "AbortError");
        }
        this.renderer = created;
        // 取设备期间父页面可能又推了新的显示缩放
        if (this.displayScale !== displayScale) created.setDisplayScale(this.displayScale);
        if (this.fps !== fps) created.setMaxFps(this.fps);
        if (this.playbackRate !== 1) created.setPlaybackRate(this.playbackRate);
        created.setStyle(this.style);
        // 先于 load：加载时的预热与第一帧用它（渲染器按新场景的铺放换算，见 `SceneRenderer.load`）
        if (this.pointer) created.setPointer(...this.pointer);
        if (this.button) created.setButton(true);
        // 音频订阅在渲染器建好之前就被拒了（P4e 步骤 4）：场景频谱同样关掉
        if (this.audioError !== null) created.disableAudio();
        created.setBackground(schemeColor(this.properties));
        const info = created.adapterInfo;
        this.options.report.debug(
          `场景渲染器：${info.vendor} ${info.architecture} ${info.description}`.trim(),
          `BC=${info.features.includes("texture-compression-bc")}`,
        );
        return created;
      },
      (error) => {
        if (this.rendererTask === task) this.rendererTask = null;
        throw error;
      },
    );
    this.rendererTask = task;
    return task;
  }

  private fallback(reasons: string[]): void {
    this.dropRenderer();
    // 退回预览图：场景不显示，声音也停（下次能渲染时重新开始）
    this.disposeSounds();
    this.disposeVideos();
    // 媒体事件不派发了：队列清掉（订阅与状态保留，计时器在退回期间把新事件直接丢掉）
    this.sceneMedia?.discard();
    // 关键帧动画同样丢掉：下次能渲染时从 0 开始
    this.sceneAnimations = null;
    this.scenePuppets = null;
    this.pendingAnimations = null;
    this.pendingPuppets = null;
    this.bundle = null;
    this.registry = null;
    this.resetRestructure();
    this.disposeLive();
    this.closeCompileSession();
    this.scriptState = null;
    this.scriptNeedsFullApply = true;
    this.pendingParticles.calls.length = 0;
    this.pendingParticles.states.clear();
    const key = reasons.join("\n");
    if (this.state === "fallback" && key === this.lastFallback) return;
    this.state = "fallback";
    this.lastFallback = key;
    this.options.report.warn(`场景壁纸 ${this.options.imageId} 退回预览图：`, reasons);
    this.options.report.fallback(reasons);
  }

  /**
   * 父页面下发五项设置（`kabegame:wpe-scene-settings`）。第一条叫醒等着的 `reload`；之后和最近一次加载用的值比，变了才整场重载
   * （五项都决定编译结果：泛光链 / HDR、反射名单、阴影变体与图集、体积光的 RT 与 `QUALITY`、有不支持项时退回还是照常渲染），
   * 几项一起变只重载一次，记进探针的 recompiled（原因 settings）。缺了的项（旧的父页面）按跟随、强制渲染按关。
   */
  setSceneSettings(next: {
    postprocess: unknown;
    reflection: unknown;
    shadows: unknown;
    volumetrics?: unknown;
    forceRender?: unknown;
  }): void {
    if (this.disposed) return;
    this.sceneSettings = {
      postprocess: asPostprocess(next.postprocess),
      reflection: asReflection(next.reflection),
      shadows: asShadows(next.shadows),
      volumetrics: asVolumetrics(next.volumetrics),
      forceRender: next.forceRender === true,
    };
    for (const wake of this.sceneSettingsWaiters.splice(0)) wake();
    // 还没加载过：在等的 reload 会读到这份
    if (!this.receivedProperties || this.postprocess === null) return;
    const resolved = this.resolvedSceneSettings();
    const keys: string[] = [];
    if (resolved.postprocess !== this.postprocess) keys.push("postprocess");
    if (resolved.reflection !== this.reflection) keys.push("reflection");
    if (resolved.shadows !== this.shadows) keys.push("shadows");
    if (resolved.volumetrics !== this.volumetrics) keys.push("volumetrics");
    if (resolved.forceRender !== this.forceRenderSetting) keys.push("forceRender");
    if (!keys.length) return;
    const before = [this.postprocess, this.reflection, this.shadows, this.volumetrics, this.forceRenderSetting].join(
      "/",
    );
    const after = [
      resolved.postprocess,
      resolved.reflection,
      resolved.shadows,
      resolved.volumetrics,
      resolved.forceRender,
    ].join("/");
    this.options.report.debug(
      `场景壁纸 ${this.options.imageId} 设置变化（${keys.join("、")}）：${before} → ${after}，重新判定`,
    );
    this.stats.recompiled.push({ reason: "settings", keys });
    void this.reload();
  }

  /** 编译用的四项：父页面的值，反射、阴影与体积光再叠 dev 覆盖（`localStorage`，生产构建摇掉） */
  private resolvedSceneSettings(): SceneSettings {
    const settings = this.sceneSettings ?? FOLLOW_SCENE_SETTINGS;
    return {
      postprocess: settings.postprocess,
      reflection: reflectionOverride() ?? settings.reflection,
      shadows: shadowsOverride() ?? settings.shadows,
      volumetrics: volumetricsOverride() ?? settings.volumetrics,
      forceRender: settings.forceRender,
    };
  }

  /**
   * 等父页面的第一条设置；没有父页面回应（dev 工具直接开的宿主没替它回）时等满上限按跟随 WPE，记一条 warn。
   * 不在 iframe 里（没有父页面，单测在 node 里）不等，直接按跟随。
   */
  private async readSceneSettings(): Promise<SceneSettings> {
    const framed = typeof window !== "undefined" && window.parent !== window;
    if (!this.sceneSettings && !framed) this.sceneSettings = FOLLOW_SCENE_SETTINGS;
    if (!this.sceneSettings) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const index = this.sceneSettingsWaiters.indexOf(wake);
          if (index >= 0) this.sceneSettingsWaiters.splice(index, 1);
          if (!this.sceneSettings) {
            this.options.report.warn(
              `场景壁纸 ${this.options.imageId}：${SCENE_SETTINGS_WAIT_MS} ms 内没收到父页面的场景设置，按跟随 WPE 处理`,
            );
            this.sceneSettings = FOLLOW_SCENE_SETTINGS;
          }
          resolve();
        }, SCENE_SETTINGS_WAIT_MS);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.sceneSettingsWaiters.push(wake);
      });
    }
    return this.resolvedSceneSettings();
  }

  /** 属性、档位或设备变化时重新编译；代数确保过期结果不能覆盖新场景。 */
  private async reload(): Promise<void> {
    if (!this.options.imageId) {
      this.fallback(["host:missing-image-id"]);
      return;
    }
    const id = ++this.generation;
    this.reloading = true;
    this.switchPending = true;
    this.controller?.abort();
    const abort = (this.controller = new AbortController());
    if (this.state !== "ready") this.state = "loading";
    const started = performance.now();
    // 加载进度（`progress.ts`）：只在首次加载时报给父页面（重编译时旧画面一直在画）、被新的加载取代后不再报；分段计时两种都记，进日志
    const load = new SceneLoadProgress(
      this.state === "ready"
        ? null
        : (stage, done, total) => {
            if (id === this.generation) this.options.report.progress?.(stage, done, total);
          },
    );
    // 编译用的裸值快照：属性只作为编译输入，同时记下来供场景换上（或退回）后补差
    let compiledWith: Record<string, unknown> | null = null;
    // 这次加载打开的编译会话（L2）：没交给 `this.compileSession` 之前归这个局部变量，finally 保证没交出去就关
    let held: CompileSessionClient | null = null;
    // 这次加载的运行中建层（L5）：场景换上时交给 `this.live`，没交出去的 finally 里丢掉
    let live: LiveObjects<PreparedObject> | null = null;
    try {
      // 场景目录与 assets 目录不随属性变化，取一次；失败不缓存，下次重载再取
      const targetTask = (this.targetTask ??= invoke<SceneTarget>("wpe_scene_target", {
        imageId: this.options.imageId,
      }).catch((error: unknown) => {
        this.targetTask = null;
        throw error;
      }));
      const [target, { postprocess: setting, reflection, shadows, volumetrics, forceRender }] = await Promise.all([
        targetTask,
        this.readSceneSettings(),
      ]);
      if (id !== this.generation) return;
      this.postprocess = setting;
      this.reflection = reflection;
      this.shadows = shadows;
      this.volumetrics = volumetrics;
      this.forceRenderSetting = forceRender;
      // 有不支持项时照常渲染：用户设置「强制渲染」（打开时确认过），或 dev 覆盖
      const force = forceRender || devForceRender();
      const userProperties = Object.fromEntries(
        [...this.properties].map(([key, property]) => [key, property.value as SceneScalar]),
      );
      compiledWith = { ...userProperties };
      const opened = await openSceneSession({
        projectDir: target.path,
        sceneAssets: target.sceneAssets,
        userProperties,
        scriptOverrides: Object.fromEntries(this.scriptOverrides),
        structure: {
          destroyed: [...this.structure.destroyed],
          parents: this.structure.parents.map((item) => [...item]) as SceneStructure["parents"],
          created: this.structure.created.map((item) => ({ ...item })),
        },
        // 脚本模型数据层的描述（P14）：重载后这些层仍在
        modelData: this.collectModelData(),
        postprocess: setting,
        reflection,
        shadows,
        volumetrics,
        force,
        textureCache: this.textureCache,
        reader: this.reader,
        signal: abort.signal,
        onProgress: (stage, done, total) => load.report(stage, done, total),
      }).catch((error: unknown) => {
        throw isAbort(error) ? error : new SceneRenderError(reasonsOf(error, "compile"));
      });
      const bundle = opened.bundle;
      const session = (held = opened.session);
      if (id !== this.generation) return;
      if (bundle.unsupported.length) {
        if (!force) {
          this.fallbackAfterLoad(bundle.unsupported, compiledWith);
          return;
        }
        this.options.report.warn(
          `场景壁纸 ${this.options.imageId} 强制渲染（${forceRender ? "设置" : "dev"}），不支持项：`,
          bundle.unsupported,
        );
      }
      // 文本、声音、媒体、视频、用户纹理、脚本 init、取设备：进度的 `prepare` 阶段（日志里「准备」「取设备」两段）
      load.report("prepare", 0, 1);
      // 文本（P6b 1d）：排版要 wasm 与字体字节，在声音、脚本与 GPU 资源之前排好（读字体是异步的，之后比代数）。wasm 不在或排版
      // 出错时抛 `text:engine`，由下面的 catch 退回预览图
      let texts: Map<number, TextLayout> | undefined;
      // 运行中重排（P6b 1e）：绑定这次加载的图集，交给渲染器；缺字体读完时 `onTextReady` 把那一层重新标脏
      let relayout: TextRelayouter | undefined;
      if (bundle.layers.some((layer) => layer.text)) {
        this.sceneTexts ??= new SceneTexts({
          reader: this.reader,
          report: this.options.report,
          onReady: (object) => this.onTextReady(object),
        });
        const prepared = await this.sceneTexts.prepare(bundle, target, () => id !== this.generation);
        if (id !== this.generation || !prepared) return;
        texts = prepared;
        relayout = this.sceneTexts.relayouter() ?? undefined;
      }
      // 登记表（L4 起在建 GPU 场景之前建，L5 起在脚本 `init` 之前建：`init` 里建的层接进这份）：粒子序号的属主，渲染器建场景时按它定粒子层的随机种子；
      // 换上场景时（`beforeFirstFrame`）才成为当前的
      const registry = new SceneRegistry(bundle);
      // 运行中建层（L5）：片段缓存按这份 bundle 预置（会话算的无损对象），属于这个会话；`init` 期间的建层先落在它上面，场景换上时成为 `live`
      const loading = {
        texts: new Map<number, TextLayout>(),
        pending: [] as Promise<void>[],
        reload: null as string | null,
      };
      const sceneLive = (live = new LiveObjects(
        this.liveTarget(registry, loading),
        (request) => session.compileFragment(request),
        this.stats.created,
      ));
      sceneLive.cache.seed(bundle, opened.exactConfigs);
      // 声音在对象加载时就开始（WPE 不等第一帧），在脚本与 GPU 资源之前
      this.loadSounds(bundle);
      // 场景用音频（P4e 步骤 4）：声明了开关且有带音频的粒子模块，加载就订阅（只订一次）
      if (bundle.audio) this.subscribeAudio();
      // 系统媒体集成（P11c）：脚本导出了媒体回调、或有封面纹理槽；要在脚本 `init` 之前建好（`init` 之后的补发读 `SceneMedia`）
      await this.loadMedia(bundle, target.sceneAssets);
      if (id !== this.generation) return;
      // 视频纹理同样在脚本与 GPU 资源之前开始读、开始放（P9a）
      this.loadVideos(bundle);
      // 用户纹理（P11b 步骤 2）：按当前属性值预先解码，建场景时第一帧就是用户图
      const primed = await this.primeUserTextures(bundle);
      if (id !== this.generation) return;
      // runtime 已赋值但脚本还在加载时也要等，否则会抢在 init 之前进入首帧
      if ((!this.runtime || this.runtimeTask) && bundle.scripts.list.length && !this.scriptUnavailable) {
        this.scriptBundle = bundle;
        this.scriptState = SceneState.fromBundle(bundle);
        syncAllocator(this.allocator, bundle);
        // 相机基准（P5e）：WPE 先跑全部脚本的 `init`、后读 `scene.json` 的 `camera`，所以 `init` 读写的是构造缺省值；跑完之后按加载规则收尾
        this.scriptState.beginScriptInit();
        // 先按新 bundle 建好动画播放器，`init` 里的 getAnimation().play() 才有落点（见 `pendingAnimations`）
        const player = new SceneAnimations(bundle.animations ?? []);
        // 加载期间又来一次加载（重编译）：脚本环境已经建好或正在跑 `init`（`runtime` 已赋值），之前的 `init` 控制的是上一份待用播放器，
        // 它们不会再跑，接过来；`runtime` 还没赋值时 `init` 还没开始，之后按 `scriptBundle` 落到这一份上，不用接
        if (this.runtime && this.pendingAnimations) player.carryOver(this.pendingAnimations.player);
        this.pendingAnimations = { bundle, player };
        // puppet 运行时同理（P12c）：`init` 里对动画层的 setFrame / play 要有落点
        const pendingPuppets = new ScenePuppets(puppetEntries(bundle.layers));
        if (this.runtime && this.pendingPuppets) pendingPuppets.carryOver(this.pendingPuppets.puppets);
        this.pendingPuppets = { bundle, puppets: pendingPuppets };
        // `init` 里的 `createLayer` 落在这次加载上（L5 点 4）
        this.loadingLive = sceneLive;
        // `init` 里的 `setParent` 重算的是这份登记表（L7）
        this.loadingRegistry = registry;
        try {
          await this.ensureRuntime(bundle, target.sceneAssets);
        } finally {
          if (this.loadingLive === sceneLive) this.loadingLive = null;
          if (this.loadingRegistry === registry) this.loadingRegistry = null;
        }
        // `init` 全部跑完：相机基准按加载规则收尾，被 `scene.json` 覆盖的字段把脚本的写入从重放表里去掉（重编译不复活）。放在代数判断之前：
        // 被取代的加载也跑过 `init`，之后的加载不再进这个分支，不收尾就没人做了（幂等）
        for (const field of this.scriptState?.finishScriptInit() ?? [])
          this.runtime?.forgetWrite(this.targetPath({ kind: "camera-base", field }));
        if (id !== this.generation) return;
        // `init` 里建了层（P6d3b → L5 点 4）：命中缓存的已经接进 bundle；没命中的等会话编完、逐个接进来（还没有 GPU 场景），再建 GPU 场景，首帧就带
        // 新对象，不再整场编第二次。片段带 `sceneFlips`、编失败时照旧放弃本次、带着结构整场重编（脚本环境保留，`init` 不重跑）
        // `init` 里写的对象级重编译目标（L6，如文本层的 `font`）同样在这里接进来；同一对象写了几次时，到达后按最新的再发一次（排出新的一项），所以
        // 等到队空为止
        while (sceneLive.queue.size > 0) {
          await sceneLive.settled();
          if (id !== this.generation) return;
          sceneLive.drain();
        }
        if (loading.pending.length > 0) {
          await Promise.all(loading.pending);
          if (id !== this.generation) return;
        }
        if (loading.reload !== null) {
          this.options.report.debug(`场景脚本 init 里建的图层接不进来（${loading.reload}），带结构重新编译`);
          void this.reload();
          return;
        }
        // `init` 里建的文本层：排版交给建场景（没有文本层的 bundle 这时才有当前加载的图集与重排器）。`init` 里单对象重编译换掉的文本层（L6）：
        // 建场景前排的旧排版放掉引用
        if (loading.texts.size > 0) {
          for (const [object, layout] of loading.texts) {
            const old = texts?.get(object);
            if (old && old !== layout) this.sceneTexts?.releaseLayout(old);
          }
          texts = new Map([...(texts ?? []), ...loading.texts]);
          relayout = this.sceneTexts?.relayouter() ?? relayout;
        }
      }
      load.mark("取设备");
      const current = await this.ensureRenderer();
      if (id !== this.generation) return;
      current.setPaused(this.paused);
      // puppet（P12a 步骤 4）：新建，在 `beforeFirstFrame` 里接回旧时钟并算一次姿势；没有 puppet 的场景是空运行时（`frame` 什么都不做）
      // 图像层 puppet 与带骨骼的模型对象（P12b2-1）都进运行时
      // 首次加载时 `init` 已经在待用的运行时上控制过：属于这份 bundle 就直接用（P12c）
      const pendingPuppets = this.pendingPuppets?.bundle === bundle ? this.pendingPuppets : null;
      const stalePuppets = pendingPuppets ? null : this.pendingPuppets;
      const puppets = pendingPuppets?.puppets ?? new ScenePuppets(puppetEntries(bundle.layers));
      await current.load(bundle, {
        ignoreUnsupported: force,
        texts,
        relayout,
        userTextures: this.userTextures,
        puppets,
        particleOrdinal: (object) => registry.particleOrdinal(object),
        // 脚本模型数据（P14）：数据仓随脚本运行时换（清空脚本存储），GPU 场景每次取当前的
        modelData: () => this.modelData,
        onProgress: (stage, done, total) => load.report(stage, done, total),
        beforeFirstFrame: (state) => {
          // 重载进行中建的对象（L5 点 4）：编译快照之后建的，新 bundle 里没有。先在新状态上照旧下标建壳（结构接续之前：对象表与父子要接得上），
          // 换上之后再走一遍建层的两条路（下面 `late`）
          const previous = this.scriptState;
          const late = this.structure.created.filter(
            (item) => !state.layers.has(item.object) && !this.structure.destroyed.includes(item.object),
          );
          for (const item of late)
            addShellObject(state, item.object, item.config, previous?.layers.get(item.object)?.parent ?? null);
          // 结构接续（P6d3a）：旧脚本状态里的对象表 / 待删 / 父子（首次加载时是 `init` 里 `sortLayer` / `setParent` / `destroyLayer` 落下的，
          // bundle 是 `init` 之前编的、不含它们）；重编译后 bundle 已带结构，照搬是幂等的。在重放脚本写入之前
          if (this.scriptState && this.scriptState !== state) state.adoptStructure(this.scriptState);
          // 纹理动画的私有状态（P6e 点 3）：脚本手里的外壳认同一个条目对象
          if (this.scriptState && this.scriptState !== state) state.adoptTextureAnimations(this.scriptState);
          // 新建 → carryOver → refresh（同 P10 的 `write`）：重编译时动画层时钟与 blendin 的清位接着走，换上就按当前时钟与当前状态算一次蒙皮，
          // 不闪出绑定姿势；之后每帧由 `stepPuppets` 推进
          // 待用的（`init` 里的控制要保留）不接旧时钟；否则接上正在播的，没有时接过期的待用运行时（P12c）
          this.pendingPuppets = null;
          if (!pendingPuppets) puppets.carryOver(this.scenePuppets ?? stalePuppets?.puppets ?? null);
          // 状态的动画层字段按运行时的层表对齐（P12e）：运行时建的层从脚本状态拷、删过的编译期层去掉；在 `refresh` 之前（它读状态）、重放脚本写入之前
          state.syncAnimationLayers(
            puppets.liveLayers(),
            this.scriptState !== state ? this.scriptState : null,
            puppets.objects(),
          );
          puppets.refresh(stateSink(state));
          this.scenePuppets = puppets;
          // 运行中属性写进状态时同步交给来源表解码（P11b 步骤 2）；解码完成再经 `onUserTextureReady` 标脏
          this.userTextureKinds = new Map(
            (bundle.userTextures ?? []).map((source) => [source.name, source.kind] as const),
          );
          state.onUserTexture = (name, value) =>
            this.userTextures.setValue(name, value, this.userTextureKinds.get(name));
          // 预解码超时：建场景时这些槽用的是缺省纹理，超时后才解完的那几个在建场景前的 `onReady` 找不到状态、没标脏，这里补标，第一次 `sync` 换上
          if (!primed)
            for (const source of bundle.userTextures ?? [])
              if (source.kind !== "system" && this.userTextures.status(source.name) === "ready")
                state.touchUserTexture(source.name);
          // 渲染器从这一帧起画这份 bundle：视频的下标按它换算（`videoSink`）
          this.drawingBundle = bundle;
          this.scriptBundle = bundle;
          this.scriptState = state;
          // 登记表跟着这份 bundle（L3b）：换场景 / 重编译时换新的（L4：建 GPU 场景之前已建好，粒子序号从它取）
          this.registry = registry;
          // 运行中的组内问题与没做的重排属于旧场景（L7）：新场景按 bundle 建，组内问题编译期已报
          this.resetRestructure();
          // 运行中建层与编译会话跟着换手（L5）：旧场景排着的放弃（旧场景随之销毁），新会话用得上才留，否则编完就关
          this.disposeLive();
          this.live = sceneLive;
          this.closeCompileSession();
          if (sessionUseful(bundle)) {
            this.compileSession = held;
            held = null;
          }
          // 从这一帧起（含换上时画的第一帧里脚本的写入）对象级重编译交给新场景（L6）
          if (id === this.generation) this.switchPending = false;
          // 新建对象编进了 bundle（P6d3b）：脚本条目换成新 bundle 里的（常量目标等由编译填好）、API 的待编对象清掉、分配器对齐
          syncAllocator(this.allocator, bundle);
          this.runtime?.refreshScripts(bundle.scripts.list);
          this.scriptApi?.adoptBundle();
          // 关键帧动画（P10a 步骤 3）在这里换，不在编译完就换：换上之前旧场景还在画，要接着用自己的动画；时钟也不能在建 GPU 资源期间
          // 停住再接（`carryOver` 拷的是这一刻的时间）。换上就按当前时钟写一次：暂停中重编译时首帧不跑 `beforeFrame`，不写的话先闪一下
          // 编译期的 `value`。在重放脚本写入之前：一帧里动画先写、脚本后写（rea-p10-keyframes 第 9 节）。手写的测试 bundle 可能没有动画表
          // 首次加载 / 清空脚本存储后，`init` 已经在待用的播放器上控制过：直接换上、不接旧时钟（P10b 决定 1）；待用的不是这份 bundle
          // 的（加载期间又重编译了）作废，照旧新建并接上正在播的（没有时接过期的待用播放器）
          const pending = this.pendingAnimations;
          this.pendingAnimations = null;
          let animations: SceneAnimations;
          if (pending && pending.bundle === bundle) animations = pending.player;
          else {
            animations = new SceneAnimations(bundle.animations ?? []);
            animations.carryOver(this.sceneAnimations ?? pending?.player ?? null);
          }
          this.sceneAnimations = animations;
          animations.write(state, this.pushSoundVolume);
          this.runtime?.replayWrites();
          // 挂脚本又绑属性的字段：`init` 拿的是 JSON `value`，首帧之前由属性全集覆盖（WPE 的「init 之后全集绑定一次」）。
          // 与 `applyChanges` 同一份属性表（含内置项）；在脚本的 `applyUserProperties` 之前
          applyScriptedProperties(
            bundle.bindings,
            bundle.scripts,
            this.properties,
            state,
            this.runtime,
            this.scriptNeedsFullApply,
          );
          // 首次加载的 `init` 对粒子层调的方法（P4f 步骤 3）：新场景已经换上，补调
          this.flushPendingParticles(current);
          if (this.scriptNeedsFullApply && this.runtime) {
            this.runtime.applyUserProperties(Object.fromEntries(this.properties), this.properties, bundle.bindings);
            this.scriptNeedsFullApply = false;
          }
          // 重载进行中建的对象：新场景上再走一遍建层的两条路（命中新缓存的当场装上，没命中的排进新会话）
          for (const item of late)
            this.createOn(sceneLive, bundle, item.object, item.config, state.layers.get(item.object)?.parent ?? null);
        },
      });
      if (id !== this.generation) return;
      this.bundle = bundle;
      // 会话换手的兜底：正常在 `beforeFirstFrame` 里已换过（`held` 为 null）；渲染器没调它时（单测的替身）在这里换
      if (held) {
        this.closeCompileSession();
        if (sessionUseful(bundle)) {
          this.compileSession = held;
          held = null;
        }
      }
      this.compiledWith = compiledWith;
      current.setPaused(this.paused);
      for (const warning of current.warnings.splice(0))
        this.options.report.debug(`场景着色器 ${this.options.imageId}：${warning}`);
      const stats = current.sceneStats;
      const post = bundle.general.postprocess;
      const detail =
        `后处理 ${post.level}（${bloomLabel(bundle.bloom, current.sceneState?.bloomEnabled ?? false)}）` +
        (stats
          ? `，目标 ${stats.width}×${stats.height} ${stats.format}、渲染目标约 ${Math.round(stats.targetBytes / 2 ** 20)} MiB`
          : "");
      if (this.state !== "ready") {
        // 视频纹理（P9a 决定 1）：第一次 ready 之前等可见图层用到的视频出第一帧，最多 2 s。WPE 不等（第一帧之前图层透明），但 ready 之后
        // 应用页要淡入，透明的那几帧会被看见。等完补画一帧，把第一帧拷进来（循环在跑时 `redraw` 什么都不做，下一帧自然拷）。
        // 重新加载（已经 ready）时不等
        if (this.sceneVideos) {
          await this.sceneVideos.firstFrames(
            visibleVideoTextures(bundle, current.sceneState),
            FIRST_VIDEO_FRAME_TIMEOUT_MS,
          );
          // 等的期间被新的加载取代，或渲染器运行期失败已退回
          if (id !== this.generation || this.renderer !== current) return;
          current.redraw();
        }
        this.state = "ready";
        this.lastFallback = "";
        load.report("frame", 1, 1);
        this.options.report.info(
          `场景壁纸 ${this.options.imageId} 开始渲染：${bundle.layers.length} 层、${bundle.programs.length} 个程序，` +
            `${detail}，用时 ${Math.round(performance.now() - started)} ms（${load.summary()}）${this.sessionSummary()}`,
        );
        this.options.report.ready();
      } else
        this.options.report.debug(
          `场景壁纸 ${this.options.imageId} 重新加载：${detail}，用时 ${Math.round(performance.now() - started)} ms（${load.summary()}）${this.sessionSummary()}`,
        );
      // 加载期间到达的增量不丢：与编译用的快照比较，差异再走一次应用函数（P3a）
      const pending = pendingChanges(this.properties, this.compiledWith);
      if (pending.size) this.applyChanges(pending);
    } catch (error) {
      if (id !== this.generation || isAbort(error)) return;
      this.fallbackAfterLoad(reasonsOf(error, "render"), compiledWith);
    } finally {
      // 没交出去的会话（被新的加载取代、退回、出错、`init` 里建层放弃本次）一律关掉；没换上的运行中建层一起丢
      held?.close();
      if (live && live !== this.live) live.dispose();
      if (id === this.generation) {
        this.reloading = false;
        this.switchPending = false;
        if (this.scriptReloadPending && !this.scriptReloadRunning && this.state === "ready") this.requestScriptReload();
      }
    }
  }

  /**
   * 以退回告终的加载：编译期间属性又变了（加载中的增量只并进全集），就按新全集再编译一次，
   * 否则这些增量会被丢掉。第二次编译用的就是当前全集，不会循环。
   */
  private fallbackAfterLoad(reasons: string[], compiledWith: Record<string, unknown> | null): void {
    this.fallback(reasons);
    if (compiledWith && pendingChanges(this.properties, compiledWith).size) void this.reload();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
    this.dropRenderer();
    this.disposeSounds();
    this.sceneTexts?.dispose();
    this.sceneTexts = null;
    this.disposeVideos();
    this.disposeMedia();
    this.userTextures.dispose();
    this.sceneAnimations = null;
    this.scenePuppets = null;
    this.pendingAnimations = null;
    this.pendingPuppets = null;
    this.runtime?.destroy();
    this.runtime = null;
    this.registry = null;
    this.resetRestructure();
    this.scriptApi = null;
    this.modelData = null;
    this.textureCache.clear();
    this.disposeLive();
    this.closeCompileSession();
  }

  /** 丢掉当前场景的运行中建层（L5）：队里没装的放弃，缓存清掉。幂等。 */
  private disposeLive(): void {
    this.live?.dispose();
    this.live = null;
  }

  /** 关掉常驻的编译会话（L2），幂等。 */
  private closeCompileSession(): void {
    this.compileSession?.close();
    this.compileSession = null;
  }

  /** 「开始渲染」日志里的会话段：留没留、缓存字节、wasm 线性内存。 */
  private sessionSummary(): string {
    const stats = this.compileSession?.stats;
    if (!this.compileSession) return "，编译会话：关";
    return `，编译会话：留（缓存 ${Math.round((stats?.cachedBytes ?? 0) / 1024)} KiB、wasm ${Math.round((stats?.wasmBytes ?? 0) / 1024)} KiB）`;
  }
}

/**
 * 场景换上后编译会话要不要留（L2）：L5 / L6 只有两种情况用得上——脚本运行中建层或写对象级重编译字段（要求场景有脚本），
 * 或有属性改了要重编译的绑定：对象级的 `layer-structure` 重编译目标（路径 `objects/<i>/…`，L6 起只编那个对象；L7 起不认场景级的
 * `general/perspectiveoverridefov`，它整场重载、用不着会话），以及开关会被 `needsRecompile` 挡下的 effect（L6：绑属性的 effect 在文本层上
 * （冻结的图层），或它自己带不支持项）。结构变化（L7）不用会话。常驻 Worker 占着翻译器 wasm 实例、着色器翻译缓存与文件缓存，桌面每块屏一个壁纸窗口
 * 外加预览，用不上就关。
 */
export function sessionUseful(bundle: Pick<SceneBundle, "scripts" | "bindings" | "layers">): boolean {
  if (bundle.scripts.list.length > 0) return true;
  return bundle.bindings.some(({ target }) => {
    if (target.kind === "recompile")
      return target.reason === "layer-structure" && recompileObjectOf(target.path) !== null;
    if (target.kind !== "effect") return false;
    const layer = bundle.layers.find((item) => item.object === target.object);
    return (
      !!layer &&
      (!!layer.text || layer.effects.some((effect) => effect.source === target.effect && effect.unsupported.length > 0))
    );
  });
}
