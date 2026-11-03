import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeApply, mergeProperties, pendingChanges, planApply, type UserProperty } from "./compile/bindings";
import type { SceneBundle } from "./compile/bundle";
import { compileSceneInWorker } from "./compile/client";
import { TextureDecodeCache } from "./compile/decode";
import { FetchSceneReader } from "./compile/fs";
import type { SceneScalar } from "./compile/model";
import { SCENE_POSTPROCESS_SETTINGS, type ScenePostprocessSetting } from "./compile/postprocess";
import { reasonsOf, SceneRenderError, SceneRenderer } from "./render";
import type { SceneReporter } from "./report";

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
    if (plan.recompile.length || !this.renderer?.applyBindings(plan.writes)) {
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
    this.stats.applied++;
    this.options.report.debug(`场景壁纸 ${this.options.imageId} 就地更新：${[...changes.keys()].join(",")}`);
  }

  /** dev 探针：当前 bundle 与渲染器（生产构建不访问）。 */
  get devScene(): { bundle: SceneBundle | null; renderer: SceneRenderer | null } {
    return { bundle: this.bundle, renderer: this.renderer };
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
      const current = await this.ensureRenderer();
      if (id !== this.generation) return;
      await current.load(bundle, { ignoreUnsupported: force });
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
    this.textureCache.clear();
  }
}
