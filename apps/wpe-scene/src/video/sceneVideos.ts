/**
 * 一张场景的全部视频纹理（P9a 步骤 1）：渲染器经 `VideoSink` 推进帧号、问新帧，宿主经 `SceneVideos` 换 bundle、暂停与恢复。
 * 不碰 GPU：`GpuScene` 拿到帧来源（`VideoFrame` 或元素）后自己 `copyExternalImageToTexture`。WPE 语义见 p9-REPORT「结论」与
 * rea-p9-video 第 3、4 节。
 *
 * - **帧号**：每个实时帧开头 `beginFrame()` 加一（补画帧不调，暂停期间帧号不走），对应 WPE 场景渲染函数每帧给 `ctx+0x144` 加一。
 * - **复用**：按视频在磁盘上的区间（`path` + `start` + `end`）复用播放器：跨重编译不重读、不打断（决定 2）。bundle 按文件路径给纹理去重，
 *   同一段视频只会对应一个纹理下标；万一两个下标同区间，也共用一个播放器（WPE 的纹理缓存同样共享一个播放器，rea 第 4 节，推断）。
 * - **30 帧规则**：纹理连续 30 个渲染帧没被画到就暂停，再画到时立即 `play()`、不追赶（rea 第 4 节）。新建的播放器 `lastDrawn` 取当前帧号，
 *   所以一开始就不可见的图层也先播 30 帧（p9-REPORT「不可见的图层」）。
 * - **宿主暂停**：全部 `pause()`；恢复时照 WPE 把**所有**播放器的 `wantPlay` 置真再放，连脚本暂停、停止过的也放（rea 第 3 节第 5 条）。
 * - **脚本**（P9b）：`IVideoTexture` 经 `layerVideoSource` 从脚本当前看到的 bundle 找图层槽 0 的视频，再经 `playerFor` 按区间键取播放器，
 *   不经纹理下标：重编译期间脚本还在用旧 bundle、这里已按新 bundle 重建下标表，区间键照样对得上。
 * - **两种播放器**（P9d 步骤 2a）：有 WebCodecs 时先建 `CodecVideoPlayer`（自己拆包、`VideoDecoder` 解码、自己的媒体时钟）。它拆包是
 *   异步的，`load` 仍同步建好播放器、立即按当前状态开始，外部时序不变。拆不了（`indexVideo` 给出原因：不是 MP4 / Matroska、编码不是
 *   H.264 / HEVC、表不一致等；Matroska 自 P9d 步骤 3 起也自己拆）时它经
 *   `onUnsupported` 回到这里，`fallBack` 记一条 warn、建旧的 `VideoTexturePlayer` 顶替同一个区间键与下标：拆包期间脚本只可能改过
 *   想放、loop、rate、结束回调与 currentTime（还没有帧，时钟没走过），`takeScriptState` 把它们原样交给旧播放器，脚本下一次经
 *   `playerFor` 现取就拿到新的；`firstFrames` 按区间键等，被顶替时接着等新的。没有 WebCodecs（`VideoDecoder` 不存在、也没注入
 *   `createDecoder`，例如 Node 单测）时直接建旧播放器。
 */
import type { SceneBundle } from "../compile/bundle";
import { CodecVideoPlayer, type CodecFactories, type CodecVideoProbe } from "./codecPlayer";
import {
  VideoTexturePlayer,
  videoSourceKey,
  type SceneVideoSource,
  type VideoFactories,
  type VideoPlayerProbe,
  type VideoReport,
} from "./player";

/** `GpuScene.copyVideo` 认的帧来源：WebCodecs 解出的帧，或退回时的 `<video>` 元素（P9d 步骤 2a）。 */
export type VideoFrameSource = VideoFrame | HTMLVideoElement;

/** 场景视频播放器的公共面：`VideoTexturePlayer` 与 `CodecVideoPlayer` 都满足（`SceneVideos` 与脚本 `IVideoTexture` 只经它用播放器）。 */
export interface SceneVideoPlayer {
  readonly source: SceneVideoSource;
  wantPlay: boolean;
  lastDrawn: number;
  readonly fresh: boolean;
  readonly failed: boolean;
  readonly hasFirstFrame: boolean;
  rate: number;
  loop: boolean;
  currentTime: number;
  readonly duration: number;
  apply(frame: number, hostPaused: boolean): void;
  drawn(frame: number, hostPaused: boolean): VideoFrameSource | null;
  detectEnd(): void;
  firstFrame(): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  isPlaying(): boolean;
  resetScriptState(): void;
  addEndedCallback(callback: () => void): void;
  probe(): VideoPlayerProbe;
  dispose(): void;
}

/** 两种播放器的部件都可注入：旧播放器的元素与 Blob，新播放器的区间读取、解码器与配置检查（墙钟共用）。 */
export type SceneVideoFactories = VideoFactories & CodecFactories;

/** 渲染器一侧的接口：`GpuScene` 与 `SceneRenderer` 只认它，dev 探针的确定性回放可以换上自己的实现。 */
export interface VideoSink {
  /** 每个实时帧开头：帧号 +1，检测绕回 / 结束并调回调，再按「lastDrawn + 30 < 帧号」暂停空闲的视频。补画帧不调。 */
  beginFrame(): void;
  /** 画到绑定这张纹理（bundle 纹理下标）的 draw 时调：记帧号、空闲中的恢复播放；有新帧就交出帧来源（交出即清标志）。 */
  drawn(texture: number): VideoFrameSource | null;
}

/**
 * 图层基础材质槽 0 的视频（P9b，WPE `getVideoTexture` 的判定：基础材质 `+0xd0` 是纹理槽 0、纹理标志带视频位，rea-p9-video 第 6 节）：
 * `passes[0].textures[0]` 指向的 bundle 纹理带 `video` 时返回它，否则（没有这个图层、槽 0 不是 bundle 纹理、不是视频）undefined。
 * 只看 bundle、不看播放器在不在：语料诊断与 `realmProbe` 没有播放器，也照样认得出视频图层。
 * 槽 0 被用户纹理换成视频时（P11b 步骤 4），WPE 的 `getVideoTexture()` 会返回那个视频的包装（rea-p11b 3.2 末行）；这里不做：
 * 只认 bundle 里的 `.tex` 视频，用户视频的播放器在 `usertex/sources.ts`，不经脚本接口。
 */
export function layerVideoSource(
  bundle: Pick<SceneBundle, "layers" | "textures"> | null | undefined,
  object: number,
): SceneVideoSource | undefined {
  const texture = bundle?.layers.find((layer) => layer.object === object)?.passes[0]?.textures[0];
  // 手写的测试 bundle 可能没有纹理表
  return texture === undefined ? undefined : bundle?.textures?.[texture]?.video;
}

/** 旧播放器的探针，补上 `decoder: "element"`。 */
export interface ElementVideoProbe extends VideoPlayerProbe {
  decoder: "element";
}

/** dev 探针：一段视频的状态（`decoder` 区分两种播放器）。 */
export type SceneVideoProbe = (ElementVideoProbe | CodecVideoProbe) & {
  /** 当前渲染帧号（和 `lastDrawn` 比就知道空闲了几帧）。 */
  frame: number;
  /** 用到这段视频的纹理下标。 */
  textures: number[];
};

export class SceneVideos implements VideoSink {
  private frame = 0;
  private hostPaused = false;
  private disposed = false;
  /** 区间键 → 播放器。 */
  private players = new Map<string, SceneVideoPlayer>();
  /** bundle 纹理下标 → 播放器，每次 `load` 重建。 */
  private byTexture = new Map<number, SceneVideoPlayer>();
  /** 有 WebCodecs：注入了解码器，或浏览器有 `VideoDecoder`。 */
  private readonly codecs: boolean;

  constructor(
    private readonly report: VideoReport,
    private readonly factories: SceneVideoFactories = {},
  ) {
    this.codecs = !!factories.createDecoder || typeof VideoDecoder !== "undefined";
  }

  /** 换上 bundle 的视频纹理：按区间复用已有播放器，新出现的建播放器并立即按当前状态开始，这次用不到的释放；下标表重建。 */
  load(textures: readonly { video?: SceneVideoSource }[]): void {
    if (this.disposed) return;
    const players = new Map<string, SceneVideoPlayer>();
    const byTexture = new Map<number, SceneVideoPlayer>();
    textures.forEach((texture, index) => {
      const video = texture.video;
      if (!video) return;
      const key = videoSourceKey(video);
      let player = players.get(key) ?? this.players.get(key);
      if (!player) {
        player = this.create(video);
        player.apply(this.frame, this.hostPaused);
      }
      players.set(key, player);
      byTexture.set(index, player);
    });
    for (const [key, player] of this.players) if (!players.has(key)) player.dispose();
    this.players = players;
    this.byTexture = byTexture;
  }

  /** 有 WebCodecs 时建 `CodecVideoPlayer`（拆不了时经 `fallBack` 换成旧的），否则直接建旧的 `VideoTexturePlayer`。 */
  private create(video: SceneVideoSource): SceneVideoPlayer {
    if (!this.codecs) return new VideoTexturePlayer(video, this.frame, { ...this.factories, report: this.report });
    const player: CodecVideoPlayer = new CodecVideoPlayer(video, this.frame, {
      ...this.factories,
      report: this.report,
      onUnsupported: (reason) => this.fallBack(player, reason),
    });
    return player;
  }

  /**
   * `CodecVideoPlayer` 拆不了包：建旧播放器顶替同一个区间键与它占的下标，接过脚本状态（`takeScriptState`）与 `lastDrawn`，按当前帧号与
   * 宿主暂停开始。这期间已被 `load` 换掉或整个释放的，什么都不做（它已经被释放了）。
   */
  private fallBack(codec: CodecVideoPlayer, reason: string): void {
    const key = videoSourceKey(codec.source);
    if (this.disposed || this.players.get(key) !== codec) return;
    const { path, start, end } = codec.source;
    this.report.warn(`场景视频不能用 WebCodecs 解码，退回 <video>：${path} [${start}, ${end})`, reason);
    const state = codec.takeScriptState();
    const player = new VideoTexturePlayer(codec.source, this.frame, { ...this.factories, report: this.report });
    player.lastDrawn = state.lastDrawn;
    player.wantPlay = state.wantPlay;
    if (!state.loop) player.loop = false;
    if (state.rate !== 1) player.rate = state.rate;
    for (const callback of state.endedCallbacks) player.addEndedCallback(callback);
    if (state.seekTo !== null) player.currentTime = state.seekTo;
    this.players.set(key, player);
    for (const [index, owner] of this.byTexture) if (owner === codec) this.byTexture.set(index, player);
    player.apply(this.frame, this.hostPaused);
  }

  beginFrame(): void {
    if (this.disposed) return;
    this.frame++;
    // 结束回调在这一帧的脚本 update 之前（p9-REPORT「时钟、循环」：回绕那一帧的 update 之前调用）；loop 为假的结束会清 wantPlay，
    // 所以先判定再 apply
    for (const player of this.players.values()) {
      player.detectEnd();
      player.apply(this.frame, this.hostPaused);
    }
  }

  drawn(texture: number): VideoFrameSource | null {
    if (this.disposed) return null;
    return this.byTexture.get(texture)?.drawn(this.frame, this.hostPaused) ?? null;
  }

  /** 这个纹理下标的播放器，没有时 null。下标随重编译变，脚本侧改用 `playerFor`；它只剩单测在用。 */
  player(texture: number): SceneVideoPlayer | null {
    return this.disposed ? null : (this.byTexture.get(texture) ?? null);
  }

  /** 这段视频（按区间键 `videoSourceKey`）的播放器，没有时 null：脚本 `IVideoTexture` 的落点（P9b）。 */
  playerFor(source: SceneVideoSource): SceneVideoPlayer | null {
    return this.disposed ? null : (this.players.get(videoSourceKey(source)) ?? null);
  }

  /** 「清空脚本存储」重启脚本：每个播放器的脚本状态恢复缺省（`resetScriptState`）。 */
  resetScriptState(): void {
    if (this.disposed) return;
    for (const player of this.players.values()) player.resetScriptState();
  }

  /** 宿主暂停或文档隐藏。 */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.hostPaused) return;
    this.hostPaused = paused;
    // 恢复时连失败的播放器也置真（之后 isPlaying 为真、仍没有帧）：WPE 对每个有播放器的纹理调 play()，探测失败的播放器同样置 `P+0x90`
    if (!paused) for (const player of this.players.values()) player.wantPlay = true;
    for (const player of this.players.values()) player.apply(this.frame, paused);
  }

  /**
   * ready 之前等这些纹理出第一帧（决定 1）：都出了、或已失败、或超时就 resolve，不 reject。没有视频的下标不等。按区间键等：
   * `CodecVideoPlayer` 退回旧播放器时（`fallBack`）接着等顶替它的那个。
   */
  firstFrames(textures: readonly number[], timeoutMs: number): Promise<void> {
    const pending = new Set<string>();
    for (const index of textures) {
      const player = this.byTexture.get(index);
      if (player && !player.hasFirstFrame && !player.failed) pending.add(videoSourceKey(player.source));
    }
    if (pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      void Promise.all([...pending].map((key) => this.firstFrameOf(key))).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 这个区间键当前的播放器出了第一帧（或失败、释放、不在了）；等的期间被顶替就接着等新的。 */
  private async firstFrameOf(key: string): Promise<void> {
    for (;;) {
      const player = this.disposed ? undefined : this.players.get(key);
      if (!player || player.hasFirstFrame || player.failed) return;
      await player.firstFrame();
      if (this.players.get(key) === player) return;
    }
  }

  probe(): SceneVideoProbe[] {
    return [...this.players.values()].map((player) => ({
      ...(player instanceof CodecVideoPlayer ? player.probe() : { ...player.probe(), decoder: "element" as const }),
      frame: this.frame,
      textures: [...this.byTexture].filter(([, owner]) => owner === player).map(([index]) => index),
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.byTexture.clear();
  }
}
