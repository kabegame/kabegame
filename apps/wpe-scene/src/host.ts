import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import type { SceneBundle } from "./compile/bundle";
import { compileSceneInWorker } from "./compile/client";
import { TextureDecodeCache } from "./compile/decode";
import { FetchSceneReader } from "./compile/fs";
import type { BindingTarget } from "./compile/bindings";
import type { SceneScalar } from "./compile/model";
import { SCENE_POSTPROCESS_SETTINGS, type ScenePostprocessSetting } from "./compile/postprocess";
import { reasonsOf, SceneRenderError, SceneRenderer } from "./render";
import type { SceneStyle } from "./render/layout";
import { SceneState, scriptWriteValue } from "./render/state";
import { daytimeOf } from "./render/uniforms";
import type { SceneReporter } from "./report";
import { schemeColor } from "./sceneStyle";
import { ScriptApi, createWpeLocalStorage } from "./script/api";
import { createIframeRealm, getJsModuleIndex } from "./script/realm";
import { ScriptRuntime, type ScriptTarget } from "./script/runtime";
import { browserStorage, clearSceneStorage } from "./script/storage";

interface SceneTarget {
  path: string;
  sceneAssets: string[];
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

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 日志里的泛光状态：有链不等于开着，当前开不开看场景位。 */
function bloomLabel(bloom: SceneBundle["bloom"], enabled: boolean): string {
  if (!bloom) return "无泛光";
  const label = enabled ? "泛光" : "泛光（关）";
  return bloom.hdr ? `${label} + HDR` : label;
}

/** 每个 iframe 只有一个 SceneHost；属性由垫片推送，实例随 iframe 一同销毁。 */
export class SceneHost {
  private style: SceneStyle = "fill";
  /** 父页面量的显示缩放（`sceneStyle.ts` 的协议），渲染器建好前先存着。 */
  private displayScale = 1;
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
  /**
   * 累计全集（WPE 渲染器 `+0x1728`，I1）：键 → `{ type, value }`。保留 `type`，不学 WPE 的整项覆盖（I4）。
   * 加载传全集、运行时传增量，两条路都走 `apply`。
   */
  private readonly properties = new Map<string, UserProperty>();
  /** 当前场景编译时用的裸值快照；场景换上后与全集比较，补上加载期间到达的增量。 */
  private compiledWith: Record<string, unknown> = {};
  /** 当前场景的 bundle（取绑定表）与渲染器（就地写）。 */
  private bundle: SceneBundle | null = null;
  private scriptBundle: SceneBundle | null = null;
  private scriptState: SceneState | null = null;
  private runtime: ScriptRuntime | null = null;
  private scriptApi: ScriptApi | null = null;
  private readonly scriptOverrides = new Map<string, number[] | boolean>();
  private scriptReloadPending = false;
  private scriptReloadRunning = false;
  private reloading = false;
  private scriptUnavailable = false;
  private scriptNeedsFullApply = true;
  private runtimeTask: Promise<void> | null = null;
  private readonly consoleErrors = new Map<string, { minute: number; count: number; skipped: number }>();
  /** 音频只订一次（被拒也不重试）；后面三项只给 dev 探针读。 */
  private audioSubscribed = false;
  private audioError: string | null = null;
  private audioFrames = 0;
  private lastAudioFrame: number[] | null = null;
  /**
   * 声音对象的播放（P6a 步骤 1）：第一张带声音的 bundle 到达时建，重编译保留（同一对象播放不中断），退回预览图与销毁时释放。
   * 宿主音量 h 由垫片交来（`setHostVolume`），收到之前按 0：不建 `AudioContext`、不读文件。
   */
  private sceneSounds: SceneSounds | null = null;
  private soundPlayer: ScenePlayer | null = null;
  private hostVolume = 0;
  private hidden = false;
  /** dev 探针计数：就地应用次数与重编译记录。 */
  readonly stats: SceneHostStats = { applied: 0, recompiled: [] };
  private receivedProperties = false;
  private readonly reader = new FetchSceneReader();
  private readonly textureCache = new TextureDecodeCache(this.reader);
  private targetTask: Promise<SceneTarget> | null = null;
  private readonly unlisteners: UnlistenFn[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: { imageId: string | null; report: SceneReporter },
  ) {
    this.listenEvent<Record<string, unknown>>("setting-change", "场景后处理设置", (raw) => {
      if (this.disposed || !this.receivedProperties) return;
      const delta = (raw && typeof raw.changes === "object" ? raw.changes : raw) as Record<string, unknown> | null;
      if (!delta || !("wpeScenePostprocess" in delta)) return;
      const next = asPostprocess(delta.wpeScenePostprocess);
      if (this.postprocess !== null && next === this.postprocess) return;
      // 设置变化引起的重载也计入探针的 recompiled（原因记 settings）
      this.stats.recompiled.push({ reason: "settings", keys: ["wpeScenePostprocess"] });
      options.report.debug(`场景壁纸 ${options.imageId} 后处理设置 ${this.postprocess} → ${next}，重新判定`);
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
   * 音频订阅保留（`audioSubscribed` 不复位）：Channel 的消息总是写进当时的 `scriptApi`，新脚本注册的缓冲照样收到。
   */
  private restartScriptsWithClearedStorage(imageId: string): void {
    const hadRuntime = this.runtime !== null;
    // 先停脚本再删：destroy 回调可能还会写
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
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
    if (target.kind === "recompile") return target.path;
    return `${target.script}/scriptproperties/${target.key}`;
  }

  private readScript(target: ScriptTarget): number[] | boolean | null {
    const state = this.scriptState;
    if (!state) return null;
    if (target.kind === "layer") {
      const value = state.layers.get(target.object)?.[target.field];
      return value === undefined ? null : typeof value === "number" ? [value] : value;
    }
    if (target.kind === "effect") return state.effectEnabled(target.object, target.effect);
    if (target.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
    if (target.kind === "bloom") {
      const value = state.bloom[target.field];
      return Array.isArray(value) ? value : [value];
    }
    if (target.kind === "bloom-enabled") return state.bloomEnabled;
    if (target.kind === "general") {
      const value = state.general[target.key];
      return typeof value === "number" ? [value] : value;
    }
    if (target.kind === "sound") {
      const value = state.sounds.get(target.object)?.volume;
      return value === undefined ? null : [value];
    }
    return null;
  }

  private writeScript(target: ScriptTarget, value: number[] | boolean): boolean {
    if (target.kind === "unsupported" || target.kind === "script-property") return false;
    if (target.kind === "recompile") return this.overrideAndReload(target.path, value);
    const state = this.scriptState;
    if (!state) return false;
    const result = state.write({ property: "", target }, scriptWriteValue(value));
    // 声音的 `volume`（P6a 步骤 2：API 写入与字段脚本写回）当场交给排期器：WPE 的回调 `V` 在改值时调、没有渐变，暂停时也生效。
    // 读脚本看到的状态：首次加载 `init` 期间它还不是渲染器的状态（首帧前重放写入时再同步一次）
    if (target.kind === "sound") {
      const volume = state.sounds.get(target.object)?.volume;
      if (volume !== undefined) this.sceneSounds?.scheduler(target.object)?.setVolume(volume);
    }
    // 打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景：状态没变，结果由整场编译决定，编译要拿到脚本的值
    return result === "recompile" ? this.overrideAndReload(this.targetPath(target), value) : true;
  }

  /** 脚本写重编译类目标：值变了才记进覆盖表、请求重新编译（脚本可能每帧写同一个值）。 */
  private overrideAndReload(path: string, value: number[] | boolean): boolean {
    const old = this.scriptOverrides.get(path);
    if (JSON.stringify(old) === JSON.stringify(value)) return true;
    if (old === undefined && JSON.stringify(this.recompileValue(path)) === JSON.stringify(value)) return true;
    this.scriptOverrides.set(path, value);
    this.stats.recompiled.push({ reason: `script（${path}）`, keys: [] });
    this.options.report.debug(`场景脚本重编译目标变化：${path}`);
    this.requestScriptReload();
    return true;
  }

  private recompileValue(path: string): number[] | boolean | undefined {
    return path === "general/hdr" ? this.scriptBundle?.general.postprocess.hdrFlag : undefined;
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
   * 脚本第一次注册音频缓冲时向 `WpeMediaHub` 订阅，Hub 有订阅才开回环采集。订阅归属宿主 frame，frame 销毁时由
   * Phase 8 的 `SubframeDestroyed` 释放，没有退订命令；重编译保留 realm 与缓冲，也不用重订。
   */
  private subscribeAudio(): void {
    const imageId = this.options.imageId;
    if (this.audioSubscribed || !imageId) return;
    this.audioSubscribed = true;
    const channel = new Channel<{ type: string; data?: number[] }>();
    channel.onmessage = (message) => {
      if (message.type !== "audio" || !message.data) return;
      this.audioFrames++;
      this.lastAudioFrame = message.data;
      this.scriptApi?.applyAudioFrame(message.data);
    };
    // 没声明 supportsaudioprocessing 或非 Windows 时被拒：缓冲保持全零，不报错（同 Phase 8 垫片），只记 debug
    invoke("wpe_web_media_subscribe", { kind: "audio", channel, imageId }).catch((error: unknown) => {
      this.audioError = String(error);
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
    const direct = this.scriptApi?.recompileWrites;
    return (this.runtime?.diagnostics ?? []).map((item) => {
      const record = item as { id: string; recompileWrites?: number };
      return { ...record, recompileWrites: (record.recompileWrites ?? 0) + (direct?.get(record.id) ?? 0) };
    });
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

  /** dev 探针：音频是否已订阅（`error` 是被拒的原因）、收到的帧数、已注册的分辨率与最近一帧的峰值。 */
  audio(): { subscribed: boolean; error: string | null; frames: number; resolutions: number[]; peak: number } {
    return {
      subscribed: this.audioSubscribed && this.audioError === null,
      error: this.audioError,
      frames: this.audioFrames,
      resolutions: this.scriptApi?.audioResolutions ?? [],
      peak: this.lastAudioFrame ? Math.max(...this.lastAudioFrame) : 0,
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
    // 粒子 `instanceoverride` 的就地值（P4a 步骤 5）：状态里的值，与模拟器正在用的相同
    const instance = /^objects\/(\d+)\/instanceoverride\/(\w+)$/.exec(path);
    if (instance)
      return (
        state.particleInstances.get(Number(instance[1]))?.[
          instance[2] as keyof import("./compile/particles").ParticleInstanceValues
        ] ?? null
      );
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
  }

  /** 排期器看到的全局音量：暂停或隐藏时为 0，否则是宿主音量；暂停 / 恢复另交给播放器淡变。 */
  private syncSoundGlobal(): void {
    const active = !this.paused && !this.hidden;
    this.sceneSounds?.setGlobal(active ? this.hostVolume : 0, active);
  }

  private soundVolumeOf = (object: number): number | undefined => this.renderer?.sceneState?.sounds.get(object)?.volume;

  private syncSoundVolumes(): void {
    this.sceneSounds?.syncVolumes(this.soundVolumeOf);
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
    this.renderer?.setPointer(x, y);
  }

  setStyle(style: SceneStyle): void {
    this.style = style;
    this.renderer?.setStyle(style);
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
      stepObjects: (dt) => this.sceneSounds?.step(dt, this.soundVolumeOf),
      beforeFrame: (dt) => {
        if (this.state !== "fallback" && this.scriptState) this.runtime?.frame(dt);
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
    this.bundle = null;
    this.scriptState = null;
    this.scriptNeedsFullApply = true;
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
      const [target, setting] = await Promise.all([targetTask, this.readPostprocess()]);
      if (id !== this.generation) return;
      this.postprocess = setting;
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
      // 声音在对象加载时就开始（WPE 不等第一帧），在脚本与 GPU 资源之前
      this.loadSounds(bundle);
      // runtime 已赋值但脚本还在加载时也要等，否则会抢在 init 之前进入首帧
      if ((!this.runtime || this.runtimeTask) && bundle.scripts.list.length && !this.scriptUnavailable) {
        this.scriptBundle = bundle;
        this.scriptState = SceneState.fromBundle(bundle);
        await this.ensureRuntime(bundle, target.sceneAssets);
        if (id !== this.generation) return;
      }
      const current = await this.ensureRenderer();
      if (id !== this.generation) return;
      current.setPaused(this.paused);
      await current.load(bundle, {
        ignoreUnsupported: force,
        beforeFirstFrame: (state) => {
          this.scriptBundle = bundle;
          this.scriptState = state;
          this.runtime?.replayWrites();
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
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
    this.textureCache.clear();
  }
}
