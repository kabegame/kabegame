import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EMPTY_ANIMATIONS_PROBE, SceneAnimations, type AnimationsProbe } from "./animation/player";
import { ScenePuppets, stateSink } from "./puppet/player";
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
import { compileSceneInWorker } from "./compile/client";
import { TextureDecodeCache } from "./compile/decode";
import { FetchSceneReader } from "./compile/fs";
import type { BindingTarget } from "./compile/bindings";
import type { SceneScalar } from "./compile/model";
import {
  SCENE_POSTPROCESS_SETTINGS,
  SCENE_REFLECTION_SETTINGS,
  type SceneReflectionSetting,
  type ScenePostprocessSetting,
} from "./compile/postprocess";
import { reasonsOf, SceneRenderError, SceneRenderer } from "./render";
import { emptyCursorInput, type CursorInputSnapshot } from "./render/cursor";
import type { SceneStyle } from "./render/layout";
import { uploadableTextures, visibleObjects } from "./render/scene";
import { SceneState } from "./render/state";
import { daytimeOf } from "./render/uniforms";
import type { SceneReporter } from "./report";
import { schemeColor } from "./sceneStyle";
import { instanceControlPoint, type InstanceField } from "./compile/particles";
import { ScriptApi, createWpeLocalStorage, type ParticleScriptTarget } from "./script/api";
import { applyScriptedProperties } from "./script/initialApply";
import { createIframeRealm, getJsModuleIndex } from "./script/realm";
import { ScriptRuntime, scriptDiagnostics, type ScriptTarget, type ScriptValue } from "./script/runtime";
import { readScriptState, recordRecompileWrite, writeScriptState } from "./script/stateWrite";
import { browserStorage, clearSceneStorage } from "./script/storage";
import { SceneTexts, type TextRelayouter } from "./text/host";
import type { TextLayout } from "./text/layout";
import { UserTextureSources, type UserTextureProbe } from "./usertex/sources";
import { videoSourceKey } from "./video/player";
import { layerVideoSource, SceneVideos, type SceneVideoProbe, type VideoSink } from "./video/sceneVideos";

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
  type: string;
  value: unknown;
}

/** 宿主计数（dev 探针读）：就地应用次数与每次重编译的原因 / 键。 */
export interface SceneHostStats {
  applied: number;
  recompiled: { reason: string; keys: string[] }[];
}

const LOST_RETRY_WINDOW_MS = 60_000;
/** 第一次 ready 之前最多等视频纹理出第一帧这么久（P9a 决定 1）。 */
const FIRST_VIDEO_FRAME_TIMEOUT_MS = 2000;
const FORCE_RENDER_KEY = "kabegame-dev-scene-force-render";

function forceRender(): boolean {
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
  private postprocess: ScenePostprocessSetting | null = null;
  /** 设置「场景反射」（P13b1）：最近一次加载用的值；还没加载过为 null。 */
  private reflection: SceneReflectionSetting | null = null;
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
  private scriptBundle: SceneBundle | null = null;
  private scriptState: SceneState | null = null;
  private runtime: ScriptRuntime | null = null;
  private scriptApi: ScriptApi | null = null;
  private readonly scriptOverrides = new Map<string, ScriptValue>();
  private scriptReloadPending = false;
  private scriptReloadRunning = false;
  private reloading = false;
  private scriptUnavailable = false;
  private scriptNeedsFullApply = true;
  private runtimeTask: Promise<void> | null = null;
  private readonly consoleErrors = new Map<string, { minute: number; count: number; skipped: number }>();
  /** 音频只订一次（被拒也不重试）；`audioFrames` 只给 dev 探针读。 */
  private audioSubscribed = false;
  private audioError: string | null = null;
  private audioFrames = 0;
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
  /** dev 探针计数：就地应用次数与重编译记录。 */
  readonly stats: SceneHostStats = { applied: 0, recompiled: [] };
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
  });
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
    },
  ) {
    this.userTextures.onReady = (name) => this.onUserTextureReady(name);
    // 来源表建好后按当前暂停状态设一次（P11b 步骤 4，用户视频与 GIF 的时钟）
    this.userTextures.setPaused(this.paused || this.hidden);
    this.listenEvent<Record<string, unknown>>("setting-change", "场景后处理与反射设置", (raw) => {
      if (this.disposed || !this.receivedProperties) return;
      const delta = (raw && typeof raw.changes === "object" ? raw.changes : raw) as Record<string, unknown> | null;
      if (!delta) return;
      const keys: string[] = [];
      if ("wpeScenePostprocess" in delta) {
        const next = asPostprocess(delta.wpeScenePostprocess);
        if (this.postprocess === null || next !== this.postprocess) {
          keys.push("wpeScenePostprocess");
          options.report.debug(`场景壁纸 ${options.imageId} 后处理设置 ${this.postprocess} → ${next}，重新判定`);
        }
      }
      // 反射（P13b1）：值变才重载；两项设置同时变（一条 setting-change 带两个键）只重载一次
      if ("wpeSceneReflection" in delta) {
        const next = asReflection(delta.wpeSceneReflection);
        if (this.reflection === null || next !== this.reflection) {
          keys.push("wpeSceneReflection");
          options.report.debug(`场景壁纸 ${options.imageId} 反射设置 ${this.reflection} → ${next}，重新判定`);
        }
      }
      if (!keys.length) return;
      // 设置变化引起的重载也计入探针的 recompiled（原因记 settings）
      this.stats.recompiled.push({ reason: "settings", keys });
      void this.reload();
    });
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

  /** 按当前 bundle 的绑定表应用一批变化；有任何一条要重编译（或 `needsRecompile` 挡下了就地写）就整场重编译。 */
  private applyChanges(changes: ReadonlyMap<string, SceneScalar>): void {
    const bundle = this.bundle;
    if (!bundle) return;
    const plan = planApply(bundle.bindings, changes);
    // 写之前问：打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景时 `applyBindings` 一条都不写，这几条按重编译目标处理
    const state = this.renderer?.sceneState;
    const blocked = (state ? plan.writes.filter((write) => state.needsRecompile(write.binding, write.value)) : []).map(
      (write) => write.binding.target,
    );
    const blockedPaths = blocked.map((target) => this.targetPath(target));
    const applied = this.renderer?.applyBindings(plan.writes) ?? false;
    if (applied) {
      for (const { binding } of plan.writes) this.runtime?.forgetWrite(this.targetPath(binding.target));
      // 声音的 `volume` 当场生效（WPE 的回调 `V` 在改值时调；暂停时没有帧）
      if (plan.writes.some(({ binding }) => binding.target.kind === "sound")) this.syncSoundVolumes();
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
    if (plan.recompile.length || !applied) {
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
    // 视频的脚本状态一并复位（P9b）：新脚本的 IVideoTexture 是缺省值（loop 真、rate 1），播放器也要是；旧脚本登记的结束回调不会再调，
    // 留着只会拖住旧的脚本环境
    this.sceneVideos?.resetScriptState();
    // 动画一起从头来（P10b 决定 1）：重建后 runtime 为 null，`reload` 会走「先按新 bundle 建待用播放器」的分支（`pendingAnimations`），
    // 新 `init` 里的 play() 落在它上面，`beforeFirstFrame` 换上时不接旧时钟；所以这里不用碰 `sceneAnimations`（旧场景在新场景换上前照常画）
    // 脚本写过的重编译目标一并放弃；用户属性在重建后重新全量交给新脚本
    this.scriptOverrides.clear();
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
    if (target.kind === "effect") return `objects/${target.object}/effects/${target.effect}/visible`;
    if (target.kind === "constant") return `${target.pass}/constantshadervalues/${target.material}`;
    if (target.kind === "bloom") return `general/bloom/${target.field}`;
    // 与 `scriptOverrides` 的路径相同：兜底重编译时编译器读得到
    if (target.kind === "bloom-enabled") return "general/bloom";
    if (target.kind === "general") return `general/${target.key}`;
    if (target.kind === "particle-instance") return `objects/${target.object}/instanceoverride/${target.field}`;
    if (target.kind === "sound") return `objects/${target.object}/${target.field}`;
    // 文本字段（P6b 1e）：同脚本运行时重放表的键
    if (target.kind === "text") return `objects/${target.object}/${target.field}`;
    // 相机对象的 `fov` / `zoom`（P5d 步骤 3）
    if (target.kind === "camera") return `objects/${target.object}/${target.field}`;
    if (target.kind === "recompile") return target.path;
    // 用户纹理（P11b）：同脚本运行时的 `targetKey`
    if (target.kind === "user-texture") return `usertextures/${target.name}`;
    // puppet 动画层字段（P12a 步骤 3 点 3）：同脚本运行时的 `targetKey`
    if (target.kind === "animation-layer")
      return `objects/${target.object}/animationlayers/${target.layer}/${target.field}`;
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
    if (target.kind === "sound") {
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
   * （`script/stateWrite.ts` 的 `recordRecompileWrite`）。
   */
  private overrideAndReload(path: string, value: ScriptValue): boolean {
    if (!recordRecompileWrite(this.scriptOverrides, this.scriptBundle?.general, path, value)) return true;
    this.stats.recompiled.push({ reason: `script（${path}）`, keys: [] });
    this.options.report.debug(`场景脚本重编译目标变化：${path}`);
    this.requestScriptReload();
    return true;
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
      const api = new ScriptApi(realm, {
        bundle: () => this.scriptBundle!,
        state: () => this.scriptState!,
        // 按显示缩放为 1 算：预览缩小显示时画布变小，脚本看到的分辨率仍与桌面一致
        screenResolution: () => this.renderer?.screenResolution ?? [this.canvas.width, this.canvas.height],
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
        // 粒子层的 play / pause / stop / isPlaying / emitParticles（P4f 步骤 3）：同样每次现取
        particles: (object) => this.particleTarget(object),
        // 全局 `input`（P6c）：每次读都取渲染器最近一帧给的光标快照
        cursorInput: () => this.cursorInput,
        // 关键帧动画的 IAnimation（P10b）：待用播放器属于脚本当前看到的 bundle 时取它（首次加载的 init），否则取正在播的那份；每次现取，
        // 重编译换了播放器也接得上
        animation: (id) => {
          const pending = this.pendingAnimations;
          const player = pending && pending.bundle === this.scriptBundle ? pending.player : this.sceneAnimations;
          return player?.control(id) ?? null;
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
      await runtime.load(bundle.scripts);
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
    const sound = /^objects\/(\d+)\/volume$/.exec(path);
    if (sound) return state.sounds.get(Number(sound[1]))?.volume ?? null;
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
   * 类型（`slider` 之类）当空串（缺省纹理）。没有用户纹理的 bundle 不碰来源表。快捷方式与封面来源归 P11c、P11d，这里只处理属性。
   */
  private async primeUserTextures(bundle: SceneBundle): Promise<boolean> {
    // 手写的测试 bundle 可能没有这个表
    const sources = (bundle.userTextures ?? []).filter((source) => source.kind === "property");
    if (!sources.length) return true;
    const limit = this.options.userTexturePrimeTimeoutMs ?? USER_TEXTURE_PRIME_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = this.userTextures
      .prime(
        sources.map((source) => {
          const value = this.properties.get(source.name)?.value;
          return [source.name, typeof value === "string" ? value : ""] as const;
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
      this.sceneSounds = new SceneSounds(this.soundPlayer, Math.random, (object, file, error) =>
        this.options.report.warn(
          `场景壁纸 ${imageId} 声音对象 ${object} 的文件读不出，已从列表删掉：${file.path}`,
          error,
        ),
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
   * dev 探针（P10a 步骤 3）：每条关键帧动画的 `id`、时钟主人、`t`、`getFrame()`、`isPlaying()`、标志、最后写入的值，以及最近 600 帧
   * `frame()` 的耗时；没有场景（还没加载、退回预览图）时为空表。
   */
  animations(): AnimationsProbe {
    return this.sceneAnimations?.probe() ?? EMPTY_ANIMATIONS_PROBE;
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
    const task: Promise<SceneRenderer> = SceneRenderer.create(this.canvas, {
      displayScale,
      // 场景频谱的输入（P4e 步骤 4）：Hub 最近一次的原值，渲染器每帧开头取一次
      audioFrame: () => this.lastAudioFrame,
      stepObjects: (dt) => this.sceneSounds?.step(dt, this.soundVolumeOf),
      // 光标交互（P6c）：有脚本导出光标回调才命中；回调交给脚本运行时（同一对象上导出了它的全部脚本）
      cursor: {
        active: () => this.state !== "fallback" && (this.runtime?.hasCursorCallbacks ?? false),
        input: (snapshot) => {
          this.cursorInput = snapshot;
        },
        events: (dispatches) => {
          for (const item of dispatches) this.runtime?.cursorEvent(item.object, item.callback, item.world, item.local);
        },
      },
      // puppet（P12a 步骤 4）：用户属性写进状态后这一帧就读到（读的是渲染器正在画的那份状态）
      stepPuppets: (dt) => {
        const drawn = this.drawnState;
        if (drawn) this.scenePuppets?.frame(dt, stateSink(drawn));
      },
      videos: this.videoSink,
      beforeFrame: (dt, spectrum) => {
        // 脚本的音频缓冲改读归一化频谱（P4e 步骤 4，「决定」5）：渲染器这一帧推进之后、脚本之前拷一次
        this.scriptApi?.applySpectrum(spectrum);
        if (this.state !== "fallback" && this.scriptState) {
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
      // 透视场景按画布尺寸渲染（P5d 步骤 2，已定 6）：分辨率变了（去抖之后）整场重新加载，bundle 与尺寸无关、编译结果相同，脚本写入照常重放
      onRenderSizeChange: () => {
        if (this.rendererTask === task) void this.reload();
      },
    }).then(
      (created) => {
        if (this.rendererTask !== task || this.disposed) {
          created.destroy();
          throw new DOMException("渲染器已过期", "AbortError");
        }
        this.renderer = created;
        // 取设备期间父页面可能又推了新的显示缩放
        if (this.displayScale !== displayScale) created.setDisplayScale(this.displayScale);
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
    // 关键帧动画同样丢掉：下次能渲染时从 0 开始
    this.sceneAnimations = null;
    this.scenePuppets = null;
    this.pendingAnimations = null;
    this.bundle = null;
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

  private async readPostprocess(): Promise<ScenePostprocessSetting> {
    try {
      return asPostprocess(await invoke<string>("get_wpe_scene_postprocess"));
    } catch (error) {
      this.options.report.warn("读取场景后处理设置失败，按跟随 WPE 处理：", error);
      return "follow";
    }
  }

  private async readReflection(): Promise<SceneReflectionSetting> {
    try {
      return asReflection(await invoke<string>("get_wpe_scene_reflection"));
    } catch (error) {
      this.options.report.warn("读取场景反射设置失败，按跟随 WPE 处理：", error);
      return "follow";
    }
  }

  /** 属性、档位或设备变化时重新编译；代数确保过期结果不能覆盖新场景。 */
  private async reload(): Promise<void> {
    if (!this.options.imageId) {
      this.fallback(["host:missing-image-id"]);
      return;
    }
    const id = ++this.generation;
    this.reloading = true;
    this.controller?.abort();
    const abort = (this.controller = new AbortController());
    if (this.state !== "ready") this.state = "loading";
    const started = performance.now();
    // 编译用的裸值快照：属性只作为编译输入，同时记下来供场景换上（或退回）后补差
    let compiledWith: Record<string, unknown> | null = null;
    try {
      // 场景目录与 assets 目录不随属性变化，取一次；失败不缓存，下次重载再取
      const targetTask = (this.targetTask ??= invoke<SceneTarget>("wpe_scene_target", {
        imageId: this.options.imageId,
      }).catch((error: unknown) => {
        this.targetTask = null;
        throw error;
      }));
      const [target, setting, reflection] = await Promise.all([
        targetTask,
        this.readPostprocess(),
        this.readReflection(),
      ]);
      if (id !== this.generation) return;
      this.postprocess = setting;
      this.reflection = reflection;
      const force = forceRender();
      const userProperties = Object.fromEntries(
        [...this.properties].map(([key, property]) => [key, property.value as SceneScalar]),
      );
      compiledWith = { ...userProperties };
      const bundle = await compileSceneInWorker({
        projectDir: target.path,
        sceneAssets: target.sceneAssets,
        userProperties,
        scriptOverrides: Object.fromEntries(this.scriptOverrides),
        postprocess: setting,
        reflection,
        force,
        textureCache: this.textureCache,
        reader: this.reader,
        signal: abort.signal,
      }).catch((error: unknown) => {
        throw isAbort(error) ? error : new SceneRenderError(reasonsOf(error, "compile"));
      });
      if (id !== this.generation) return;
      if (bundle.unsupported.length) {
        if (!force) {
          this.fallbackAfterLoad(bundle.unsupported, compiledWith);
          return;
        }
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 强制渲染（dev），不支持项：`, bundle.unsupported);
      }
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
      // 声音在对象加载时就开始（WPE 不等第一帧），在脚本与 GPU 资源之前
      this.loadSounds(bundle);
      // 场景用音频（P4e 步骤 4）：声明了开关且有带音频的粒子模块，加载就订阅（只订一次）
      if (bundle.audio) this.subscribeAudio();
      // 视频纹理同样在脚本与 GPU 资源之前开始读、开始放（P9a）
      this.loadVideos(bundle);
      // 用户纹理（P11b 步骤 2）：按当前属性值预先解码，建场景时第一帧就是用户图
      const primed = await this.primeUserTextures(bundle);
      if (id !== this.generation) return;
      // runtime 已赋值但脚本还在加载时也要等，否则会抢在 init 之前进入首帧
      if ((!this.runtime || this.runtimeTask) && bundle.scripts.list.length && !this.scriptUnavailable) {
        this.scriptBundle = bundle;
        this.scriptState = SceneState.fromBundle(bundle);
        // 先按新 bundle 建好动画播放器，`init` 里的 getAnimation().play() 才有落点（见 `pendingAnimations`）
        const player = new SceneAnimations(bundle.animations ?? []);
        // 加载期间又来一次加载（重编译）：脚本环境已经建好或正在跑 `init`（`runtime` 已赋值），之前的 `init` 控制的是上一份待用播放器，
        // 它们不会再跑，接过来；`runtime` 还没赋值时 `init` 还没开始，之后按 `scriptBundle` 落到这一份上，不用接
        if (this.runtime && this.pendingAnimations) player.carryOver(this.pendingAnimations.player);
        this.pendingAnimations = { bundle, player };
        await this.ensureRuntime(bundle, target.sceneAssets);
        if (id !== this.generation) return;
      }
      const current = await this.ensureRenderer();
      if (id !== this.generation) return;
      current.setPaused(this.paused);
      // puppet（P12a 步骤 4）：新建，在 `beforeFirstFrame` 里接回旧时钟并算一次姿势；没有 puppet 的场景是空运行时（`frame` 什么都不做）
      const puppets = new ScenePuppets(
        bundle.layers.flatMap((layer) => (layer.puppet ? [{ object: layer.object, puppet: layer.puppet }] : [])),
      );
      await current.load(bundle, {
        ignoreUnsupported: force,
        texts,
        relayout,
        userTextures: this.userTextures,
        puppets,
        beforeFirstFrame: (state) => {
          // 新建 → carryOver → refresh（同 P10 的 `write`）：重编译时动画层时钟与 blendin 的清位接着走，换上就按当前时钟与当前状态算一次蒙皮，
          // 不闪出绑定姿势；之后每帧由 `stepPuppets` 推进
          puppets.carryOver(this.scenePuppets);
          puppets.refresh(stateSink(state));
          this.scenePuppets = puppets;
          // 运行中属性写进状态时同步交给来源表解码（P11b 步骤 2）；解码完成再经 `onUserTextureReady` 标脏
          state.onUserTexture = (name, value) => this.userTextures.setValue(name, value);
          // 预解码超时：建场景时这些槽用的是缺省纹理，超时后才解完的那几个在建场景前的 `onReady` 找不到状态、没标脏，这里补标，第一次 `sync` 换上
          if (!primed)
            for (const source of bundle.userTextures ?? [])
              if (source.kind === "property" && this.userTextures.status(source.name) === "ready")
                state.touchUserTexture(source.name);
          // 渲染器从这一帧起画这份 bundle：视频的下标按它换算（`videoSink`）
          this.drawingBundle = bundle;
          this.scriptBundle = bundle;
          this.scriptState = state;
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
        },
      });
      if (id !== this.generation) return;
      this.bundle = bundle;
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
        this.options.report.info(
          `场景壁纸 ${this.options.imageId} 开始渲染：${bundle.layers.length} 层、${bundle.programs.length} 个程序，` +
            `${detail}，用时 ${Math.round(performance.now() - started)} ms`,
        );
        this.options.report.ready();
      } else
        this.options.report.debug(
          `场景壁纸 ${this.options.imageId} 重新加载：${detail}，用时 ${Math.round(performance.now() - started)} ms`,
        );
      // 加载期间到达的增量不丢：与编译用的快照比较，差异再走一次应用函数（P3a）
      const pending = pendingChanges(this.properties, this.compiledWith);
      if (pending.size) this.applyChanges(pending);
    } catch (error) {
      if (id !== this.generation || isAbort(error)) return;
      this.fallbackAfterLoad(reasonsOf(error, "render"), compiledWith);
    } finally {
      if (id === this.generation) {
        this.reloading = false;
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
    this.userTextures.dispose();
    this.sceneAnimations = null;
    this.scenePuppets = null;
    this.pendingAnimations = null;
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
    this.textureCache.clear();
  }
}
