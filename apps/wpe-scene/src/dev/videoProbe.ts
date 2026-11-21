/**
 * dev 探针的视频时刻（P9a 步骤 3，P9d 步骤 2b 改用 WebCodecs）：`renderFrame` 的 `videoTime` 与确定性回放用的 `VideoSink`（`ProbeVideos`）。
 *
 * 产品的播放器（`video/codecPlayer.ts`）按墙钟放，屏外宿主里 rAF 与定时器都被节流（P9a 步骤 0），而且媒体时钟和 `g_Time` 无关
 * （WPE 同样不读 `g_Time`，rea-p9-video 第 3 节），所以确定性回放不放视频：每段视频建一个 `CodecVideoPlayer`（宿主暂停状态，时钟不走），
 * 跳到指定时刻、等目标帧到手，留一份 `clone()` 的帧给每个 draw，随即释放播放器。解码器从目标帧往回最近的关键帧喂起、丢掉早于目标帧的
 * 输出，所以拿到的就是显示时间 ≤ 目标的最新一帧，精确到帧。
 * - **时刻**：`videoTime` 是数字时对全部视频纹理生效；是对象时按 bundle 纹理的 `path` 分别给（不是视频纹理的键报错，免得拼错路径
 *   静默取 0），没给的取 0；缺省 0。WPE 的视频纹理缺省循环（p9-REPORT「时钟、循环」），超过时长时按时长取模，再钳到
 *   `[0, duration − SEEK_END_MARGIN]`（同产品播放器写 `currentTime`，p9-REPORT「脚本 API」）。时长是容器时长（`mvhd` / Matroska
 *   `Info`，同 WPE）。
 * - **等待**：第一帧（拆包、配置、解码器就绪）→ 写 `currentTime` → `seeked()`；读文件、拆包与解码都算在内，全部视频共用一个总时限
 *   `VIDEO_PREPARE_TIMEOUT_MS`，超时报错、整次渲染失败（不把没跳好的帧当结果交出去）。
 * - **失败**：读不到、拆不了包、解码出错：照产品规则这段视频保持透明（不交帧，纹理保持初值全 0，rea-p9-video 第 7、8 节），
 *   结果里 `failed: true` 并带原因。
 * - **交出**：`beginFrame` 空操作；`drawn` 每次都交出留下的那一帧，每个 draw 都拷（确定性优先，不靠新帧标志）。
 * - **释放**：`dispose` 关掉留下的帧，取消还在等的 Promise；`renderFrame` 在 finally 里调，出错也释放。
 */
import type { SceneTexture } from "../compile/bundle";
import { CodecVideoPlayer, type Acceleration, type CodecFactories } from "../video/codecPlayer";
import { SEEK_END_MARGIN, type SceneVideoSource } from "../video/player";
import type { VideoSink } from "../video/sceneVideos";

/** `videoTime`：秒。数字对全部视频纹理生效；对象按 bundle 纹理的 `path` 分别给，没给的取 0。 */
export type VideoTimeOption = number | Record<string, number>;

/** 一段视频实际取的时刻（`RenderFrameResult.videos` 的一项）。 */
export interface ProbeVideoResult {
  /** bundle 纹理的 `path`（`videoTime` 对象的键）。 */
  path: string;
  /** 实际取的时刻（秒）：跳转完读回的 `currentTime`；失败时是请求的时刻。 */
  time: number;
  /** 交出的那一帧的显示时间（秒，`timestamp / 1e6`；跳转后时间戳从 0 编，就是媒体时间）；失败时 null。 */
  frameTime: number | null;
  /** 容器时长（秒）；失败或未知时 null。 */
  duration: number | null;
  /** 画面的显示尺寸（`displayWidth` / `displayHeight`）；失败时 0。 */
  width: number;
  height: number;
  /** 解码路径：硬解，或显卡不能硬解时退到的软解（`CodecVideoPlayer`）；没走到解码（读不到、拆不了包、都不支持）为 null。 */
  acceleration: Acceleration | null;
  /** 读不到、拆不了包或解码出错：这段视频保持透明（同产品），原因在 `error`。 */
  failed: boolean;
  error?: string;
}

/** 读、seek、等当前帧的总时限（全部视频共用）。 */
export const VIDEO_PREPARE_TIMEOUT_MS = 10_000;

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
 * 实际跳到的时刻：超过时长按时长取模（WPE 的视频纹理缺省循环），再钳到 `[0, duration − SEEK_END_MARGIN]`（同产品播放器的
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
  /** 留给每个 draw 的帧（`clone()` 出来的，归探针所有）。 */
  frame: VideoFrame | null;
  time: number;
  frameTime: number | null;
  duration: number | null;
  acceleration: Acceleration | null;
  failed: boolean;
  error?: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 确定性回放的 `VideoSink`：先 `prepare`（读、拆包、解到目标帧），再交给 `GpuScene.setVideoSink`，用完 `dispose`。 */
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
    private readonly factories: CodecFactories = {},
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
        frame: null,
        time: requested,
        frameTime: null,
        duration: null,
        acceleration: null,
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

  /** 读全部视频、跳到各自的时刻、等目标帧到手。单段失败只标出；超过总时限抛 `ProbeVideoTimeout`。 */
  async prepare(timeoutMs = VIDEO_PREPARE_TIMEOUT_MS): Promise<void> {
    this.timeoutMs = timeoutMs;
    const deadline = Date.now() + timeoutMs;
    await Promise.all(this.entries.map((entry) => this.prepareOne(entry, deadline)));
  }

  beginFrame(): void {}

  /** 每次都交出留下的那一帧：每个 draw 都拷一次，不靠新帧标志（确定性优先）。失败的视频不交出，纹理保持全 0。 */
  drawn(texture: number): VideoFrame | null {
    const entry = this.byTexture.get(texture);
    if (this.disposed || !entry || entry.failed) return null;
    return entry.frame;
  }

  results(): ProbeVideoResult[] {
    return this.entries.map((entry) => ({
      path: entry.path,
      time: entry.time,
      frameTime: entry.failed ? null : entry.frameTime,
      duration: entry.duration,
      width: entry.failed ? 0 : (entry.frame?.displayWidth ?? 0),
      height: entry.failed ? 0 : (entry.frame?.displayHeight ?? 0),
      acceleration: entry.acceleration,
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
    // 播放器失败时记一条 warn，失败之后不再记：留下最后一条当原因（之前可能有「改用软件解码」这类提示）
    let reason: string | undefined;
    const player = new CodecVideoPlayer(entry.source, 0, {
      ...this.factories,
      report: {
        warn: (message, detail) => void (reason = detail === undefined ? message : `${message}：${describe(detail)}`),
      },
    });
    try {
      // 宿主暂停：时钟不走，当前帧停在目标帧上
      player.apply(0, true);
      await this.beforeDeadline(player.firstFrame(), deadline, `等 ${where} 的第一帧`);
      if (!this.disposed && !player.failed) {
        const target = videoSeekTime(entry.requested, player.duration);
        player.currentTime = target;
        await this.beforeDeadline(player.seeked(), deadline, `等 ${where} 跳到 ${target} s`);
      }
      if (this.disposed) return;
      entry.acceleration = player.probe().acceleration;
      const frame = player.failed ? null : player.drawn(0, true);
      if (!frame) {
        entry.failed = true;
        entry.error = reason ?? "没有解出目标帧";
        return;
      }
      entry.frame = frame.clone();
      entry.time = player.currentTime;
      entry.frameTime = frame.timestamp / 1e6;
      entry.duration = Number.isFinite(player.duration) ? player.duration : null;
    } catch (error) {
      if (error instanceof ProbeVideoTimeout || this.disposed) throw error;
      entry.failed = true;
      entry.error = describe(error);
    } finally {
      player.dispose();
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

  private timeout(stage: string): ProbeVideoTimeout {
    return new ProbeVideoTimeout(`${stage}：超过总时限 ${this.timeoutMs / 1000} s`);
  }

  private release(entry: Entry): void {
    entry.frame?.close();
    entry.frame = null;
  }
}
