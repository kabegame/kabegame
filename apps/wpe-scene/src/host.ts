import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeApply, mergeProperties, pendingChanges, planApply, type UserProperty } from "./compile/bindings";
import type { SceneBundle } from "./compile/bundle";
import { compileSceneInWorker } from "./compile/client";
import { TextureDecodeCache } from "./compile/decode";
import { FetchSceneReader } from "./compile/fs";
import type { BindingTarget } from "./compile/bindings";
import type { SceneScalar } from "./compile/model";
import { SCENE_POSTPROCESS_SETTINGS, type ScenePostprocessSetting } from "./compile/postprocess";
import { reasonsOf, SceneRenderError, SceneRenderer } from "./render";
import { SceneState } from "./render/state";
import { daytimeOf } from "./render/uniforms";
import type { SceneReporter } from "./report";
import { ScriptApi } from "./script/api";
import { createIframeRealm, getJsModuleIndex } from "./script/realm";
import { ScriptRuntime, type ScriptTarget } from "./script/runtime";

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

/** 每个 iframe 只有一个 SceneHost；属性由垫片推送，实例随 iframe 一同销毁。 */
export class SceneHost {
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
  private readonly consoleErrors = new Map<string, { minute: number; count: number; skipped: number }>();
  /** dev 探针计数：就地应用次数与重编译记录。 */
  readonly stats: SceneHostStats = { applied: 0, recompiled: [] };
  private receivedProperties = false;
  private readonly reader = new FetchSceneReader();
  private readonly textureCache = new TextureDecodeCache(this.reader);
  private targetTask: Promise<SceneTarget> | null = null;
  private unlisten: UnlistenFn | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: { imageId: string | null; report: SceneReporter },
  ) {
    void listen<Record<string, unknown>>("setting-change", (event) => {
      if (this.disposed || !this.receivedProperties) return;
      const raw = event.payload;
      const delta = (raw && typeof raw.changes === "object" ? raw.changes : raw) as Record<string, unknown> | null;
      if (!delta || !("wpeScenePostprocess" in delta)) return;
      const next = asPostprocess(delta.wpeScenePostprocess);
      if (this.postprocess !== null && next === this.postprocess) return;
      options.report.debug(`场景壁纸 ${options.imageId} 后处理设置 ${this.postprocess} → ${next}，重新判定`);
      void this.reload();
    })
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      })
      .catch((error) => options.report.warn("监听场景后处理设置失败：", error));
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
    if (!this.receivedProperties) {
      // 首包 = 全集：整场编译（这时不会用增量路径）
      this.receivedProperties = true;
      void this.reload();
      return;
    }
    if (!changes.size) return;
    // 退回预览图时没有 bundle 可就地写；改了属性可能就能渲染（例如关掉不支持的 effect，未启用的 effect 不查能力），重新编译
    if (this.state === "fallback") {
      void this.reload();
      return;
    }
    // 加载中不丢：落地后按 `compiledWith` 的差异再走一次
    if (this.state !== "ready" || !this.bundle) return;
    this.applyChanges(changes);
  }

  /** 按当前 bundle 的绑定表应用一批变化；有任何一条要重编译（或 GPU 侧做不了就地写）就整场重编译。 */
  private applyChanges(changes: ReadonlyMap<string, SceneScalar>): void {
    const bundle = this.bundle;
    if (!bundle) return;
    const plan = planApply(bundle.bindings, changes);
    const applied = this.renderer?.applyBindings(plan.writes) ?? false;
    if (applied) {
      for (const { binding } of plan.writes) this.runtime?.forgetWrite(this.targetPath(binding.target));
      this.stats.applied++;
      this.options.report.debug(`场景壁纸 ${this.options.imageId} 就地更新：${[...changes.keys()].join(",")}`);
    }
    for (const { path } of plan.recompile) {
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
      this.stats.recompiled.push({
        reason: plan.recompile.length ? describeApply(plan) : "就地写失败",
        keys: [...changes.keys()],
      });
      this.options.report.debug(
        `场景壁纸 ${this.options.imageId} 重新编译：${plan.recompile.length ? describeApply(plan) : "就地写失败"}（${[...changes.keys()].join(",")}）`,
      );
      void this.reload();
      return;
    }
  }

  private targetPath(target: BindingTarget): string {
    if (target.kind === "layer") return `objects/${target.object}/${target.field}`;
    if (target.kind === "constant") return `${target.pass}/constantshadervalues/${target.material}`;
    if (target.kind === "bloom") return `general/bloom/${target.field}`;
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
    if (target.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
    if (target.kind === "bloom") {
      const value = state.bloom[target.field];
      return Array.isArray(value) ? value : [value];
    }
    return null;
  }

  private writeScript(target: ScriptTarget, value: number[] | boolean): boolean {
    if (target.kind === "unsupported" || target.kind === "script-property") return false;
    if (target.kind === "recompile") {
      const old = this.scriptOverrides.get(target.path);
      if (JSON.stringify(old) === JSON.stringify(value)) return true;
      if (old === undefined && JSON.stringify(this.recompileValue(target.path)) === JSON.stringify(value)) return true;
      this.scriptOverrides.set(target.path, value);
      this.options.report.debug(`场景脚本重编译目标变化：${target.path}`);
      this.requestScriptReload();
      return true;
    }
    const state = this.scriptState;
    if (!state) return false;
    state.write({ property: "", target }, Array.isArray(value) ? value.join(" ") : value);
    return true;
  }

  private recompileValue(path: string): number[] | boolean | undefined {
    const bundle = this.scriptBundle;
    if (!bundle) return undefined;
    const effect = /^objects\/(\d+)\/effects\/(\d+)\/visible$/.exec(path);
    if (effect)
      return (
        bundle.layers
          .find((layer) => layer.object === Number(effect[1]))
          ?.effects.some((item) => item.source === Number(effect[2])) ?? false
      );
    const general: Record<string, number[] | boolean> = {
      "general/clearcolor": bundle.general.clearColor,
      "general/clearenabled": bundle.general.clearEnabled,
      "general/ambientcolor": bundle.general.ambient,
      "general/skylightcolor": bundle.general.skylight,
      "general/bloom": bundle.general.postprocess.bloom,
      "general/hdr": bundle.general.postprocess.hdr,
    };
    return general[path];
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

  private async ensureRuntime(bundle: SceneBundle, sceneAssets: string[]): Promise<void> {
    if (this.runtime || this.scriptUnavailable || !bundle.scripts.list.length) return;
    try {
      const realm = await createIframeRealm({
        document,
        scripts: bundle.scripts,
        sceneAssets,
        modules: getJsModuleIndex(sceneAssets),
        console: { log: (message) => console.log(message), error: (message) => this.scriptConsoleError(message) },
        debug: (message) => this.options.report.debug(message),
      });
      if (this.disposed) {
        realm.dispose();
        return;
      }
      const api = new ScriptApi(realm, {
        bundle: () => this.scriptBundle!,
        state: () => this.scriptState!,
        screenResolution: () => [this.canvas.width, this.canvas.height],
        frametime: () => this.renderer?.frameSeconds ?? 0,
        runtime: () => this.renderer?.runtimeSeconds ?? 0,
        timeOfDay: () => daytimeOf(new Date()),
        write: (target, value) => {
          const applied = this.writeScript(target, value);
          if (applied) this.runtime?.rememberWrite(target, value);
          return applied;
        },
        read: (target) => this.readScript(target),
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

  get scriptDiagnostics(): unknown[] {
    return this.runtime?.diagnostics ?? [];
  }

  readTarget(path: string): unknown {
    const state = this.renderer?.sceneState;
    const bundle = this.bundle;
    if (!state || !bundle) return null;
    if (path.startsWith("general/bloom")) {
      const field = path.slice("general/bloom".length);
      const names: Record<string, keyof SceneState["bloom"]> = {
        strength: "strength",
        threshold: "threshold",
        tint: "tint",
        hdrstrength: "hdrStrength",
        hdrthreshold: "hdrThreshold",
        hdrfeather: "hdrFeather",
        hdrscatter: "hdrScatter",
        hdriterations: "hdrIterations",
      };
      return state.bloom[names[field] ?? "strength"];
    }
    const layer = /^objects\/(\d+)\/(origin|scale|angles|alpha|color|brightness|visible)$/.exec(path);
    if (layer)
      return state.layers.get(Number(layer[1]))?.[layer[2] as keyof import("./render/state").LayerState] ?? null;
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
  }

  setPointer(x: number, y: number): void {
    this.renderer?.setPointer(x, y);
  }

  private dropRenderer(): void {
    this.rendererTask = null;
    this.renderer?.destroy();
    this.renderer = null;
  }

  private ensureRenderer(): Promise<SceneRenderer> {
    if (this.rendererTask) return this.rendererTask;
    const task: Promise<SceneRenderer> = SceneRenderer.create(this.canvas, {
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
      const firstRuntime = !this.runtime;
      if (firstRuntime && bundle.scripts.list.length && !this.scriptUnavailable) {
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
        `后处理 ${post.level}（${bundle.bloom ? (bundle.bloom.hdr ? "泛光 + HDR" : "泛光") : "无泛光"}）` +
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
    this.unlisten?.();
    this.dropRenderer();
    this.runtime?.destroy();
    this.runtime = null;
    this.scriptApi = null;
    this.textureCache.clear();
  }
}
