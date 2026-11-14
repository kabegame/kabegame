/**
 * dev 探针的视频时刻（P9a 步骤 3）：`renderFrame` 的 `videoTime` 与确定性回放用的 `VideoSink`（`ProbeVideos`）。
 *
 * 产品的播放器（`video/player.ts`）用元素自己的时钟放，靠 `requestVideoFrameCallback` 置新帧标志；屏外宿主里 rAF 与
 * `requestVideoFrameCallback` 都不跑（P9a 步骤 0），而且元素时钟和 `g_Time` 无关（WPE 同样不读 `g_Time`，rea-p9-video 第 3 节），
 * 所以确定性回放换上这里的实现：每段视频一个不挂 DOM、静音、不播放的 `<video>`，seek 到指定时刻、等到当前帧可用，再交给 `GpuScene`。
 * - **时刻**：`videoTime` 是数字时对全部视频纹理生效；是对象时按 bundle 纹理的 `path` 分别给（不是视频纹理的键报错，免得拼错路径
 *   静默取 0），没给的取 0；缺省 0。WPE 的视频纹理缺省循环（p9-REPORT「时钟、循环」），超过时长时按时长取模，再钳到
 *   `[0, duration − SEEK_END_MARGIN]`（同产品播放器写 `currentTime`，p9-REPORT「脚本 API」：钳制发生在媒体引擎里）。时长是 Chromium
 *   按流算的（2.516667，WPE 是容器时长 2.517），循环点附近两边可能差一帧。
 * - **等待**：`loadeddata` → 设 `currentTime` → `seeked`（或看到 `seeking` 落下）→ `readyState ≥ HAVE_CURRENT_DATA`。事件为主，
 *   `POLL_MS` 短轮询兜底（屏外跨源 frame 的定时器可能被节流，媒体事件不受影响）；读 Blob 也算在内，全部视频共用一个总时限
 *   `VIDEO_PREPARE_TIMEOUT_MS`，超时报错、整次渲染失败（不把没 seek 好的帧当结果交出去）。
 * - **失败**：读不到、长度不符、元素 `error`：照产品规则这段视频保持透明（不交出元素，纹理保持初值全 0，rea-p9-video 第 7、8 节），
 *   结果里 `failed: true` 并带原因。
 * - **交出**：`beginFrame` 空操作；`drawn` 每次都交出元素，每个 draw 都拷（确定性优先，不靠新帧标志）。
 * - **释放**：`dispose` 停元素、清 src、撤销对象地址，取消还在等的事件与定时器；`renderFrame` 在 finally 里调，出错也释放。
 */
import type { SceneTexture } from "../compile/bundle";
import { fetchVideoBlob, SEEK_END_MARGIN, type SceneVideoSource, type VideoFactories } from "../video/player";
import type { VideoSink } from "../video/sceneVideos";

/** `videoTime`：秒。数字对全部视频纹理生效；对象按 bundle 纹理的 `path` 分别给，没给的取 0。 */
export type VideoTimeOption = number | Record<string, number>;

/** 一段视频实际取的时刻（`RenderFrameResult.videos` 的一项）。 */
export interface ProbeVideoResult {
  /** bundle 纹理的 `path`（`videoTime` 对象的键）。 */
  path: string;
  /** 实际取的时刻（秒）：seek 完读回的 `currentTime`；失败时是请求的时刻。 */
  time: number;
  /** 时长（秒，Chromium 按流算）；失败或未知时 null。 */
  duration: number | null;
  /** 视频本身的尺寸（`videoWidth` / `videoHeight`）；失败时 0。 */
  width: number;
  height: number;
  /** 读不到或解码出错：这段视频保持透明（同产品），原因在 `error`。 */
  failed: boolean;
  error?: string;
}

/** 读、seek、等当前帧的总时限（全部视频共用）。 */
export const VIDEO_PREPARE_TIMEOUT_MS = 10_000;

/**
 * 要用视频（bundle 的视频纹理或用户纹理里的视频）时，宿主 frame 必须可见：主窗口最小化或隐藏时屏外宿主 iframe 的
 * `document.visibilityState` 跟着是 `hidden`，Chromium 推迟没放过媒体的 frame 的媒体加载（`RenderFrameImpl::DeferMediaLoad`），
 * `<video>` 停在 `loadstart` / `stalled`、`readyState` 0，等到总时限也拿不到帧（P11b 步骤 5 实测：主窗口隐藏时 5.8 KB 的视频
 * 3 s 没有元数据，恢复后 30 ms 出第一帧）。这里立刻报出原因，不等超时。主窗口可见时屏外宿主（挂在视口外）是 `visible`、
 * rAF 不跑，视频照常加载。
 */
export function checkVideoVisibility(
  needed: boolean,
  visibility: DocumentVisibilityState | undefined = globalThis.document?.visibilityState,
): void {
  if (needed && visibility === "hidden")
    throw new Error(
      "宿主 frame 不可见（主窗口最小化或隐藏）：Chromium 推迟媒体加载，视频纹理拿不到帧；把主窗口恢复到屏幕上再渲染",
    );
}
/** 事件之外的短轮询间隔。 */
const POLL_MS = 20;
/** `HTMLMediaElement.HAVE_CURRENT_DATA`（Node 里没有这个全局）。 */
const HAVE_CURRENT_DATA = 2;

/** 校验 `videoTime`：非负有限数，或「字符串 → 非负有限数」的对象；不合法抛 RangeError（编译之前查）。缺省原样返回 undefined。 */
export function checkVideoTime(value: unknown): VideoTimeOption | undefined {
  if (value === undefined) return undefined;
  const ok = (time: unknown) => typeof time === "number" && Number.isFinite(time) && time >= 0;
  if (typeof value === "number") {
    if (!ok(value)) throw new RangeError(`videoTime 要是非负有限数（秒），收到 ${value}`);
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RangeError(`videoTime 要是秒数，或 { <纹理路径>: 秒数 }，收到 ${JSON.stringify(value)}`);
  for (const [path, time] of Object.entries(value)) {
    if (!ok(time)) throw new RangeError(`videoTime["${path}"] 要是非负有限数（秒），收到 ${JSON.stringify(time)}`);
  }
  return value as Record<string, number>;
}

/** 这张视频纹理请求的时刻：数字对全部生效，对象按 `path` 取、没给的取 0，缺省 0。 */
export function requestedVideoTime(option: VideoTimeOption | undefined, path: string): number {
  if (option === undefined) return 0;
  if (typeof option === "number") return option;
  return Object.hasOwn(option, path) ? option[path] : 0;
}

/**
 * 实际 seek 到的时刻：超过时长按时长取模（WPE 的视频纹理缺省循环），再钳到 `[0, duration − SEEK_END_MARGIN]`（同产品播放器的
 * `currentTime` 写入）。时长未知（NaN、Infinity、≤ 0）时只钳下界。
 */
export function videoSeekTime(time: number, duration: number): number {
  const at = Math.max(0, time);
  if (!Number.isFinite(duration) || duration <= 0) return at;
  const looped = at >= duration ? at % duration : at;
  return Math.min(looped, Math.max(0, duration - SEEK_END_MARGIN));
}

/** 等待超过总时限：整次渲染失败，不当成「这段视频透明」。 */
export class ProbeVideoTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeVideoTimeout";
  }
}

interface Entry {
  /** bundle 纹理下标。 */
  index: number;
  path: string;
  source: SceneVideoSource;
  requested: number;
  element: HTMLVideoElement | null;
  url: string | null;
  time: number;
  duration: number | null;
  failed: boolean;
  error?: string;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const media = error as { code: number; message?: string };
    return `MediaError ${media.code}${media.message ? `：${media.message}` : ""}`;
  }
  return String(error);
}

/** 确定性回放的 `VideoSink`：先 `prepare`（读、seek、等当前帧），再交给 `GpuScene.setVideoSink`，用完 `dispose`。 */
export class ProbeVideos implements VideoSink {
  private readonly entries: Entry[] = [];
  private readonly byTexture = new Map<number, Entry>();
  private readonly cleanups = new Set<() => void>();
  private disposed = false;
  /** `prepare` 的总时限（毫秒），超时报错时写进消息。 */
  private timeoutMs = VIDEO_PREPARE_TIMEOUT_MS;

  constructor(
    textures: readonly Pick<SceneTexture, "path" | "video">[],
    option: VideoTimeOption | undefined,
    private readonly factories: VideoFactories = {},
    /** 对象形式的 `videoTime` 里另外认得的键：用户视频的值（P11b 步骤 4，属性里的绝对路径），不在这个表里、也不是视频纹理的键照旧抛错。 */
    userVideoValues: Iterable<string> = [],
  ) {
    textures.forEach((texture, index) => {
      if (!texture.video) return;
      const requested = requestedVideoTime(option, texture.path);
      const entry: Entry = {
        index,
        path: texture.path,
        source: texture.video,
        requested,
        element: null,
        url: null,
        time: requested,
        duration: null,
        failed: false,
      };
      this.entries.push(entry);
      this.byTexture.set(index, entry);
    });
    if (option && typeof option === "object") {
      const paths = new Set(this.entries.map((entry) => entry.path));
      const user = new Set(userVideoValues);
      const unknown = Object.keys(option).filter((path) => !paths.has(path) && !user.has(path));
      if (unknown.length)
        throw new RangeError(
          `videoTime 里的 ${unknown.map((path) => `"${path}"`).join("、")} 不是这个场景的视频纹理` +
            `（有：${[...paths, ...user].map((path) => `"${path}"`).join("、") || "没有视频纹理"}）`,
        );
    }
  }

  /** 读全部视频、seek 到各自的时刻、等到当前帧可用。单段失败只标出；超过总时限抛 `ProbeVideoTimeout`。 */
  async prepare(timeoutMs = VIDEO_PREPARE_TIMEOUT_MS): Promise<void> {
    this.timeoutMs = timeoutMs;
    const deadline = Date.now() + timeoutMs;
    await Promise.all(this.entries.map((entry) => this.prepareOne(entry, deadline)));
  }

  beginFrame(): void {}

  /** 每次都交出元素：每个 draw 都拷一次，不靠新帧标志（确定性优先）。失败的视频不交出，纹理保持全 0。 */
  drawn(texture: number): HTMLVideoElement | null {
    const entry = this.byTexture.get(texture);
    if (this.disposed || !entry || entry.failed) return null;
    return entry.element;
  }

  results(): ProbeVideoResult[] {
    return this.entries.map((entry) => ({
      path: entry.path,
      time: entry.time,
      duration: entry.duration,
      width: entry.failed ? 0 : (entry.element?.videoWidth ?? 0),
      height: entry.failed ? 0 : (entry.element?.videoHeight ?? 0),
      failed: entry.failed,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
    for (const entry of this.entries) this.release(entry);
  }

  private async prepareOne(entry: Entry, deadline: number): Promise<void> {
    const where = `${entry.path} [${entry.source.start}, ${entry.source.end})`;
    try {
      const read = this.factories.readBlob ?? fetchVideoBlob;
      const blob = await this.beforeDeadline(
        new Promise<Blob>((resolve) => resolve(read(entry.source))),
        deadline,
        `读 ${where}`,
      );
      if (this.disposed) return;
      // 注入的读取函数同样核对长度（同产品播放器）：区间被忽略时拿到的是整个文件
      const length = entry.source.end - entry.source.start;
      if (blob.size !== length) throw new Error(`长度不符：读到 ${blob.size} 字节，应为 ${length}`);
      const element = this.factories.createElement ? this.factories.createElement() : document.createElement("video");
      entry.element = element;
      element.muted = true;
      element.playsInline = true;
      element.preload = "auto";
      entry.url = (this.factories.createObjectUrl ?? ((value: Blob) => URL.createObjectURL(value)))(blob);
      element.src = entry.url;
      await this.waitFor(
        element,
        ["loadeddata", "canplay"],
        () => element.readyState >= HAVE_CURRENT_DATA,
        deadline,
        `等 ${where} 的第一帧（loadeddata）`,
      );
      const target = videoSeekTime(entry.requested, element.duration);
      // seek 开始时 `seeking` 同步变真；`seeked` 漏掉也能从它落下看出 seek 结束
      let seeked = false;
      const onSeeked = () => {
        seeked = true;
      };
      element.addEventListener("seeked", onSeeked);
      try {
        element.currentTime = target;
        await this.waitFor(
          element,
          ["seeked", "loadeddata", "canplay", "timeupdate"],
          () => (seeked || !element.seeking) && element.readyState >= HAVE_CURRENT_DATA,
          deadline,
          `等 ${where} seek 到 ${target} s`,
        );
      } finally {
        element.removeEventListener("seeked", onSeeked);
      }
      entry.time = element.currentTime;
      entry.duration = Number.isFinite(element.duration) ? element.duration : null;
    } catch (error) {
      if (error instanceof ProbeVideoTimeout || this.disposed) throw error;
      entry.failed = true;
      entry.error = describe(error);
      this.release(entry);
    }
  }

  /** `promise` 在总时限之前完成就原样返回，否则抛 `ProbeVideoTimeout`。 */
  private beforeDeadline<T>(promise: Promise<T>, deadline: number, stage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cleanups.delete(abort);
        done();
      };
      const timer = setTimeout(() => settle(() => reject(this.timeout(stage))), Math.max(0, deadline - Date.now()));
      // 被 `dispose` 打断：读取本身停不下来，结果到了也丢掉
      const abort = () => settle(() => reject(new Error("视频探针已释放")));
      this.cleanups.add(abort);
      promise.then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /**
   * 等 `done()` 为真：`events` 与 `error` 触发时、每 `POLL_MS` 各查一次。元素报错时失败（`MediaError`，调用方当成解码失败），
   * 过了总时限抛 `ProbeVideoTimeout`，释放（`dispose`）时也失败。
   */
  private waitFor(
    element: HTMLVideoElement,
    events: readonly string[],
    done: () => boolean,
    deadline: number,
    stage: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const names = [...events, "error"];
      let settled = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        for (const name of names) element.removeEventListener(name, check);
        clearInterval(poll);
        clearTimeout(timer);
        this.cleanups.delete(abort);
        if (error) reject(error);
        else resolve();
      };
      // 被 `dispose` 打断：还没有结论就按失败收尾，免得 Promise 永远挂着
      const abort = () => finish(new Error("视频探针已释放"));
      const check = () => {
        if (element.error) finish(new Error(`解码失败：${describe(element.error)}`));
        else if (done()) finish();
        else if (Date.now() >= deadline) finish(this.timeout(stage));
      };
      for (const name of names) element.addEventListener(name, check);
      poll = setInterval(check, POLL_MS);
      timer = setTimeout(check, Math.max(0, deadline - Date.now()));
      this.cleanups.add(abort);
      check();
    });
  }

  private timeout(stage: string): ProbeVideoTimeout {
    return new ProbeVideoTimeout(`${stage}：超过总时限 ${this.timeoutMs / 1000} s`);
  }

  private release(entry: Entry): void {
    const element = entry.element;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    if (entry.url !== null) {
      (this.factories.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url)))(entry.url);
      entry.url = null;
    }
  }
}
