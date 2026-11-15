/**
 * 场景视频纹理的 WebCodecs 播放器（P9d 步骤 2a，phase-9d「总体设计思路」与「步骤 2a」）：一段视频一个 `CodecVideoPlayer`，不经过
 * `<video>`——宿主自己从磁盘区间拆出每一帧的压缩数据（`demux/`，MP4 与 Matroska），交给 WebCodecs 的 `VideoDecoder` 解码，解出的
 * `VideoFrame` 由这里按自己的媒体时钟挑出当前帧，GpuScene 画到视频纹理时 `copyExternalImageToTexture(VideoFrame)`。对外语义和
 * `player.ts` 的 `VideoTexturePlayer` 完全相同（WPE 依据见那边的文件头、p9-REPORT「结论」与 rea-p9-video 第 3、4、6、7 节），只换内部：
 *
 * - **读**：`ReadRange`（相对视频起点；缺省按 `source.path` 带 Range 头 `fetch(file:)`，偏移加 `source.start`，核对长度）。先
 *   `indexVideo` 拿帧表（MP4 / Matroska 按魔数分派）；拆不了（分片 MP4、编码不支持、Matroska 的 lacing 等）时交给 `onUnsupported`，
 *   由 `SceneVideos` 换成旧的 `<video>` 播放器；读本身失败（文件不在、长度不符）不退回、直接失败，退回去也一样读不到。之后按解码
 *   顺序连续读约 4 MiB 一块（`BLOCK_BYTES`），至多两块在手：正在喂的一块与预读的下一块，喂过去的丢掉。
 * - **解码**：`decoderConfig(track)`（codec 串、description、照 WPE 的色彩空间，步骤 1 点 2）；`isConfigSupported` 不支持、解码器
 *   `error`、`decode` 抛错 → 失败。解码器只解不播（决策「解码器只解不播」）：按解码顺序吃进、按显示顺序吐出，时钟与挑帧都在这里。
 * - **流控**：解码队列（`decodeQueueSize`）+ 已解出未显示的帧合计不超过 `MAX_AHEAD`（8）。硬件解码的输出帧来自一个有限的池子，
 *   握着不放会让解码器拿不到空闲输出缓冲而停住（P9c 步骤 0 的卡住就是这样，见 `player.ts` 文件头）；所以不在放时也不多喂。
 * - **时间戳**：喂进解码器的时间戳（微秒）= `round((n × 时长 + 样本显示时间) × 10⁶)`，n 是从本次跳转起喂到第几遍。循环时不停顿地
 *   接着喂下一遍（不 flush），解出的帧仍按时间戳单调排在后面；媒体时钟也按「展开」的时间走（`clock`，从本次跳转起算、不绕回），
 *   绕了几遍记在 `loops`，所以挑帧直接比 `timestamp ≤ round(clock × 10⁶)`，跨循环不用换算。媒体时间 = `clock − loops × 时长`。
 *   跳转时解码器 reset、`clock` 设为目标、`loops` 与 n 都归零，时间戳从头编。每次跳转登记喂进去的时间戳（`pending`），输出的时间戳
 *   不在登记里就是 reset 之前的残留，直接关掉。
 * - **时钟**：媒体时间只在「在放」时按墙钟 × 速率前进：`wantPlay && !宿主暂停 && 没空闲（帧号 ≤ lastDrawn + 30）&& 未结束`，且出了
 *   第一帧、不在跳转中、已被画到过一次（`started`：第一次 `drawn` 才起步，消掉开场时视频比场景早 0.3–1.4 s，phase-9d「总体设计思路」）。
 *   时长取 `source.duration ?? track.duration`（容器时长，WPE 的 `GetDuration`）；`loop` 时走到时长绕回，否则停在时长、`ended`。
 *   不追赶：空闲、暂停期间时钟停着，恢复后接着走（WPE 不追赶，rea 第 4 节）。凡是会改变「在放」结论的地方都先 `advance()` 结清
 *   之前那段时间。
 * - **挑帧**：显示时间 ≤ 媒体时间的最新一帧成为当前帧并置 `fresh`；被越过的直接 `close()`、计入丢帧；当前帧留到被替换时再
 *   `close()`——GpuScene 的拷贝是同步入队的，交出之后播放器仍持有它，下一次替换时才释放。
 * - **跳转**（脚本 `currentTime` 写、`stop`、结束后 `play`、卡住重置）：`reset()` + 重新 `configure`，关掉已解出未显示的帧，从显示时间
 *   ≤ 目标帧的最近关键帧（按解码顺序往回找）开始喂，丢掉显示时间早于目标帧的输出；目标帧到了才换当前帧（之前一直显示旧帧）。
 *   脚本暂停期间照旧不交帧（P9b 步骤 0：seek 读回会变、画面不变，到 play() 之后第一次画到才换）。
 * - **卡住**（替代 P9c 的 `watchStall`）：画到时看，在放（或在跳转）、没有已解出的帧、解码器有待解的输入、喂帧没有在等读盘，
 *   且墙钟 `STALL_MS`（2 s）没有任何输出 → reset 并从当前媒体时间重新跳转，记 warn、计数 `stallResets`。
 * - **失败**：同旧播放器——标为失败、不再交帧（纹理保持全 0，图层透明，rea 第 7、8 节），记一条 warn、清 `wantPlay`、释放解码器与帧。
 */
import { fileToUrl } from "../fileUrl";
import { decoderConfig, wpeColor } from "./demux/config";
import { indexVideo } from "./demux/index";
import type { ReadRange, VideoTrackIndex } from "./demux/mp4";
import {
  IDLE_FRAMES,
  SEEK_END_MARGIN,
  STALL_MS,
  type SceneVideoSource,
  type VideoPlayerProbe,
  type VideoReport,
} from "./player";

/** 解码队列 + 已解出未显示的帧的上限（phase-9d 步骤 2a 点 1「流控」）。 */
export const MAX_AHEAD = 8;
/** 预读一块的字节数（约 4 MiB，按解码顺序连续的样本），至多两块在手。 */
export const BLOCK_BYTES = 4 * 1024 * 1024;

/** 解码器的回调：解出的帧、出错。 */
export interface CodecDecoderInit {
  output(frame: VideoFrame): void;
  error(error: unknown): void;
}

/** 播放器用到的 `VideoDecoder` 子集；`decode` 收 `EncodedVideoChunk` 的初始化参数，缺省实现自己建 chunk（测试替身就不用 chunk 类）。 */
export interface CodecDecoder {
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunkInit): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** 可注入的部件：测试用替身，缺省用浏览器的。 */
export interface CodecFactories {
  /** 这段视频的区间读取（相对视频起点），缺省 `fileRangeReader`。 */
  readRange?: (source: SceneVideoSource) => ReadRange;
  createDecoder?: (init: CodecDecoderInit) => CodecDecoder;
  isConfigSupported?: (config: VideoDecoderConfig) => Promise<{ supported?: boolean }>;
  /** 墙钟（毫秒，媒体时钟与卡住计时用，缺省 `performance.now()`）。 */
  now?: () => number;
  /** 预读一块的字节数，缺省 `BLOCK_BYTES`（测试用小值）。 */
  blockBytes?: number;
}

export interface CodecPlayerOptions extends CodecFactories {
  report: VideoReport;
  /**
   * 拆包失败（封装不认识、编码不支持、lacing 等，`indexVideo` 的原因）时调：`SceneVideos` 换成旧的 `<video>` 播放器。之后这个播放器什么
   * 都不做，等着被 `takeScriptState` 收走。不给时按失败处理。
   */
  onUnsupported?: (reason: string) => void;
}

/** dev 探针：`VideoPlayerProbe` 的字段外加解码器的计数。`paused` 表示时钟停着，`totalFrames` / `droppedFrames` 即 `decoded` / `dropped`。 */
export interface CodecVideoProbe extends VideoPlayerProbe {
  decoder: "webcodecs";
  /** 解出的帧数（不含 reset 之前的残留）。 */
  decoded: number;
  /** 被越过、没显示就关掉的帧数（跳转时早于目标的不算）。 */
  dropped: number;
  /** 已解出、还没显示的帧数。 */
  queued: number;
  /** 解码器的 `decodeQueueSize`。 */
  decodeQueue: number;
  stallResets: number;
  /** `wpeColor` 的说明，拆包之前为 null。 */
  color: string | null;
}

/** 退回旧播放器时交接的脚本状态（`takeScriptState`）。 */
export interface CodecScriptState {
  wantPlay: boolean;
  loop: boolean;
  rate: number;
  lastDrawn: number;
  endedCallbacks: (() => void)[];
  /** 拆包期间脚本写过 `currentTime`：要设回去的时间，没写过为 null。 */
  seekTo: number | null;
}

/** 缺省的区间读取：`fetch(file:)` 带 Range 头，偏移加 `source.start`。CEF 的 `file:` 响应是 200、不带 Content-Range，所以只认长度。 */
export function fileRangeReader(source: SceneVideoSource): ReadRange {
  return async (start, end) => {
    const from = source.start + start;
    const to = source.start + end;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || start < 0 || end <= start || to > source.end)
      throw new RangeError(`视频区间无效：[${from}, ${to})`);
    const response = await fetch(fileToUrl(source.path), { headers: { Range: `bytes=${from}-${to - 1}` } });
    if (!response.ok) throw new TypeError(`读取视频失败（HTTP ${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start)
      throw new Error(`视频长度不符：读到 ${bytes.length} 字节，应为 ${end - start}（Range 被忽略？）`);
    return bytes;
  };
}

/** 缺省的解码器：浏览器的 `VideoDecoder`，`decode` 时建 `EncodedVideoChunk`（构造时拷贝数据，所以可以交块的子视图）。 */
function browserDecoder(init: CodecDecoderInit): CodecDecoder {
  const decoder = new VideoDecoder({ output: (frame) => init.output(frame), error: (error) => init.error(error) });
  return {
    get decodeQueueSize() {
      return decoder.decodeQueueSize;
    },
    configure: (config) => decoder.configure(config),
    decode: (chunk) => decoder.decode(new EncodedVideoChunk(chunk)),
    flush: () => decoder.flush(),
    reset: () => decoder.reset(),
    close: () => decoder.close(),
  };
}

/** 一块预读：解码顺序的样本 `[from, to)`，字节区间从 `base` 起；读完之前 `bytes` 为 null。 */
interface Block {
  from: number;
  to: number;
  base: number;
  bytes: Uint8Array | null;
}

/**
 * 一段视频的 WebCodecs 播放器。成员与 `VideoTexturePlayer` 一一对应（`SceneVideos` 与脚本 `IVideoTexture` 两边都认），另有
 * `videoWidth` / `videoHeight` 与 `takeScriptState`。
 */
export class CodecVideoPlayer {
  /** 最近一次被画到的渲染帧号（WPE 的 `P+0x60`）。建好时取当前帧号，同旧播放器。 */
  lastDrawn: number;
  /** 当前帧还没拷进纹理。 */
  fresh = false;
  failed = false;

  private readonly report: VideoReport;
  private readonly now: () => number;
  private readonly blockBytes: number;
  private readonly createDecoder: (init: CodecDecoderInit) => CodecDecoder;
  private readonly isConfigSupported: (config: VideoDecoderConfig) => Promise<{ supported?: boolean }>;
  private readonly read: ReadRange;
  private disposed = false;

  // —— 帧表与解码器 ——
  private track: VideoTrackIndex | null = null;
  private config: VideoDecoderConfig | null = null;
  private color: string | null = null;
  /** 样本下标按显示时间排序（跳转时二分找目标帧）。 */
  private displayOrder: Uint32Array = new Uint32Array(0);
  /** 解码顺序里第一个关键帧（循环时从它接着喂）。 */
  private firstKey = 0;
  private decoder: CodecDecoder | null = null;
  /** 解码器配置过（之后的跳转先 reset 再 configure）。 */
  private opened = false;

  // —— 喂帧 ——
  /** 下一个要喂的样本（解码顺序）。 */
  private feedIndex = 0;
  /** 从本次跳转起喂到第几遍（时间戳加 `feedLoop × 时长`）。 */
  private feedLoop = 0;
  /** 本遍喂到了结尾、不 loop，已 flush（取出解码器里最后几帧）。 */
  private flushed = false;
  /** 喂帧停在等读盘（卡住判定要排除这种情况）。 */
  private starved = false;
  private blocks: Block[] = [];
  /** 本次跳转以来喂进去、还没吐出来的时间戳（微秒 → 个数）。 */
  private readonly pending = new Map<number, number>();
  private pendingCount = 0;

  // —— 帧 ——
  private current: VideoFrame | null = null;
  /** 已解出、还没显示的帧，按时间戳升序。 */
  private ready: VideoFrame[] = [];
  private firstSeen = false;
  private firstFrameWaiters: (() => void)[] = [];
  private decoded = 0;
  private dropped = 0;

  // —— 时钟 ——
  /** 展开的媒体时间（秒，从本次跳转的 0 点起，不绕回）与绕过的遍数。 */
  private clock = 0;
  private loops = 0;
  private ended = false;
  /** 正在跳转：目标帧（时间戳，微秒）到之前时钟停着、不挑帧。 */
  private seeking = false;
  private seekTargetUs = 0;
  /** 拆包之前脚本写的 `currentTime`：解码器建好时从这里开始。 */
  private pendingSeek: number | null = null;
  /** 第一次 `drawn` 之后为真，时钟才起步。 */
  private started = false;
  private lastNow: number;
  private wantPlayValue = true;
  private frame: number;
  private hostPaused = false;
  private loopValue = true;
  private rateValue = 1;
  private rateWarned = false;

  // —— 结束回调（同旧播放器，WPE 的 `V+0xf0` / `V+0xf4`，rea 第 6 节）——
  private readonly endedCallbacks: (() => void)[] = [];
  private lastTime = 0;
  private armed = true;

  // —— 卡住 ——
  private stallSince: number;
  private stallSeen = Number.NEGATIVE_INFINITY;
  private stallResets = 0;

  constructor(
    readonly source: SceneVideoSource,
    frame: number,
    options: CodecPlayerOptions,
  ) {
    this.report = options.report;
    this.lastDrawn = frame;
    this.frame = frame;
    this.now = options.now ?? (() => performance.now());
    this.lastNow = this.now();
    this.stallSince = this.lastNow;
    this.blockBytes = options.blockBytes ?? BLOCK_BYTES;
    this.createDecoder = options.createDecoder ?? browserDecoder;
    this.isConfigSupported = options.isConfigSupported ?? ((config) => VideoDecoder.isConfigSupported(config));
    const base = options.readRange ? options.readRange(source) : fileRangeReader(source);
    // 注入的读取函数同步抛错也当作 reject
    this.read = (start, end) => new Promise<Uint8Array>((resolve) => resolve(base(start, end)));

    // `indexVideo` 不抛错、读失败也变成 `{ error }`：自己记下读的错误，读失败不退回旧播放器（它一样读不到），直接失败
    let readError: unknown = undefined;
    const readForIndex: ReadRange = (start, end) =>
      this.read(start, end).catch((error: unknown) => {
        readError ??= error;
        throw error;
      });
    void indexVideo(readForIndex, source.end - source.start).then((result) => {
      if (this.disposed || this.failed) return;
      if ("error" in result) {
        if (readError !== undefined) this.fail("场景视频读取失败", readError);
        else if (options.onUnsupported) options.onUnsupported(result.error);
        else this.fail("场景视频不能拆包", result.error);
        return;
      }
      this.prepare(result);
    });
  }

  // —— 生命周期 ——

  /** 帧表到手：算解码配置、显示顺序，问解码器支不支持，支持就建解码器、从 0（或拆包期间脚本写的时间）开始。 */
  private prepare(track: VideoTrackIndex): void {
    this.track = track;
    const config = decoderConfig(track);
    this.config = config;
    this.color = wpeColor(track).note;
    const order = Array.from(track.times.keys()).sort((a, b) => track.times[a] - track.times[b] || a - b);
    this.displayOrder = Uint32Array.from(order);
    const firstKey = track.keys.indexOf(1);
    this.firstKey = firstKey < 0 ? 0 : firstKey;
    new Promise<{ supported?: boolean }>((resolve) => resolve(this.isConfigSupported(config))).then(
      (support) => {
        if (this.disposed || this.failed) return;
        if (!support?.supported) {
          this.fail("场景视频的解码配置不支持", `${config.codec} ${track.codedWidth}×${track.codedHeight}`);
          return;
        }
        this.open();
      },
      (error: unknown) => this.fail("场景视频的解码配置不支持", error),
    );
  }

  private open(): void {
    try {
      this.decoder = this.createDecoder({
        output: (frame) => this.onOutput(frame),
        error: (error) => this.fail("场景视频解码失败", error),
      });
    } catch (error) {
      this.fail("场景视频解码器建不出来", error);
      return;
    }
    const target = this.pendingSeek ?? 0;
    this.pendingSeek = null;
    this.seekTo(target);
  }

  // —— 渲染器与 SceneVideos 的接口（同旧播放器）——

  /** 想放（WPE 的 `P+0x90`）：改它之前先结清时钟。 */
  get wantPlay(): boolean {
    return this.wantPlayValue;
  }

  set wantPlay(value: boolean) {
    this.advance();
    this.wantPlayValue = value;
  }

  /** 按 wantPlay、空闲（30 帧没画到）、宿主暂停推进时钟，挑帧、喂帧。 */
  apply(frame: number, hostPaused: boolean): void {
    if (this.disposed) return;
    this.advance();
    this.frame = frame;
    this.hostPaused = hostPaused;
    this.pick();
    this.pump();
  }

  /**
   * GpuScene 画到这张纹理：记帧号（第一次画到时时钟起步）；空闲暂停中的立即恢复、不追赶（rea 第 4 节）。当前帧没交出过就交出并清
   * 标志，同一帧再画到不再交出。脚本暂停 / 停止期间不交帧（P9b 步骤 0，同旧播放器）；空闲与宿主暂停时 wantPlay 仍为真，照常交帧。
   */
  drawn(frame: number, hostPaused: boolean): VideoFrame | null {
    if (this.disposed) return null;
    this.advance();
    this.lastDrawn = frame;
    this.started = true;
    this.apply(frame, hostPaused);
    this.watchStall();
    if (!this.fresh || this.failed || !this.wantPlayValue || !this.current) return null;
    this.fresh = false;
    return this.current;
  }

  /** 结束回调的判定，同 `VideoTexturePlayer.detectEnd`（WPE `FUN_1401fdf90`，rea 第 6 节）：读的是这里的媒体时间与 `ended`。 */
  detectEnd(): void {
    if (this.disposed || this.failed) return;
    this.advance();
    if (this.loopValue) {
      const time = this.mediaTime();
      if (this.lastTime > time && this.armed) this.fireEnded();
      this.armed = true;
      this.lastTime = time;
    } else if (this.ended) {
      if (this.armed) {
        this.armed = false;
        this.wantPlay = false;
        this.fireEnded();
      }
    } else this.armed = true;
  }

  /** 出了第一帧（解码器吐出第一次跳转的目标帧）。 */
  get hasFirstFrame(): boolean {
    return this.firstSeen;
  }

  /** 出了第一帧、失败或释放时 resolve，不 reject。 */
  firstFrame(): Promise<void> {
    if (this.firstSeen || this.failed || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.firstFrameWaiters.push(resolve));
  }

  /** 当前帧的显示尺寸；还没有帧时取帧表里的编码尺寸，拆包之前 0（同元素元数据之前的 `videoWidth`）。 */
  get videoWidth(): number {
    return this.current?.displayWidth ?? this.track?.codedWidth ?? 0;
  }

  get videoHeight(): number {
    return this.current?.displayHeight ?? this.track?.codedHeight ?? 0;
  }

  // —— 脚本接口（`IVideoTexture` 的落点，P9b；rea 第 6 节）——

  get rate(): number {
    return this.rateValue;
  }

  /**
   * 播放速率：时钟每墙钟秒走 `rate` 秒。WPE 不钳制，负数让工作线程的等待变成约 49 天、等于卡死（rea 第 3 节第 4 条）；不复刻，钳到 0（停住）。
   * 不是有限数的不收、保持原速率。旧播放器受 Chromium 的 [0.0625, 16] 限制，这里的时钟是自己的，其它非负有限数都收。
   */
  set rate(value: number) {
    if (this.disposed) return;
    let rate = value;
    if (!(rate >= 0)) {
      this.warnRate(`场景视频的 rate 不能为负（${value}），按 0：${this.source.path}`);
      rate = 0;
    } else if (!Number.isFinite(rate)) {
      this.warnRate(`场景视频不支持这个 rate（${value}），保持原速率：${this.source.path}`);
      return;
    }
    this.advance();
    this.rateValue = rate;
  }

  get loop(): boolean {
    return this.loopValue;
  }

  set loop(value: boolean) {
    if (this.disposed) return;
    // 到现在为止按旧的 loop 绕回或结束
    this.advance();
    this.loopValue = value;
    // 喂到结尾停住的，loop 打开后接着喂下一遍
    this.pump();
  }

  /** 媒体时间（秒）；结束时报时长（WPE 停在容器时长，读回正好等于 `duration`，P9b 步骤 0），跳转中报目标时间。 */
  get currentTime(): number {
    this.advance();
    if (this.ended) return this.duration;
    return this.mediaTime();
  }

  /** 钳到 `[0, max(0, duration − 0.005)]`，duration 不是有限数时只钳下界（p9-REPORT「脚本 API」实测，同旧播放器）。 */
  set currentTime(value: number) {
    if (this.disposed) return;
    let time = value > 0 ? value : 0;
    const duration = this.duration;
    if (Number.isFinite(duration)) time = Math.min(time, Math.max(0, duration - SEEK_END_MARGIN));
    // WPE 的 setCurrentTime：loop 下清 `V+0xf4`，自己造成的回退不当成绕回
    if (this.loopValue) this.armed = false;
    this.seekTo(time);
  }

  /** 容器时长（WPE 的 `GetDuration`，编译期读的 `source.duration`），没有时取帧表的（mvhd），拆包之前 NaN。 */
  get duration(): number {
    return this.source.duration ?? this.track?.duration ?? Number.NaN;
  }

  /** WPE：`if (isEnded) setCurrentTime(0); play()`。不经 `currentTime` 的 setter：不清结束判定（同旧播放器直接写元素）。 */
  play(): void {
    if (this.disposed) return;
    if (this.ended) this.seekTo(0);
    this.wantPlay = true;
  }

  /** WPE 的 pause 直接停引擎：`isPlaying` 立即为假，时间停住。 */
  pause(): void {
    if (this.disposed) return;
    this.wantPlay = false;
  }

  /** WPE：`pause()` + `setCurrentTime(0)`。 */
  stop(): void {
    if (this.disposed) return;
    this.pause();
    this.currentTime = 0;
  }

  /** `wantPlay && !已结束`（WPE：`P+0x90 && !IsEnded`），同旧播放器：空闲与宿主暂停期间仍为真，失败后脚本 play() 照常为真。 */
  isPlaying(): boolean {
    return !this.disposed && this.wantPlayValue && !this.ended;
  }

  /** 「清空脚本存储」重启脚本：同 `VideoTexturePlayer.resetScriptState`，不跳转，视频从当前位置接着放。 */
  resetScriptState(): void {
    if (this.disposed) return;
    this.endedCallbacks.length = 0;
    this.loop = true;
    this.rate = 1;
    this.lastTime = 0;
    this.armed = true;
    this.wantPlay = !this.failed;
  }

  /** WPE 的 `addEndedCallback`：不去重，没有删除接口；回调不带参数。 */
  addEndedCallback(callback: () => void): void {
    if (!this.disposed) this.endedCallbacks.push(callback);
  }

  probe(): CodecVideoProbe {
    this.advance();
    return {
      path: this.source.path,
      start: this.source.start,
      end: this.source.end,
      currentTime: this.ended ? this.duration : this.mediaTime(),
      paused: !this.running,
      wantPlay: this.wantPlayValue,
      lastDrawn: this.lastDrawn,
      fresh: this.fresh,
      failed: this.failed,
      videoWidth: this.videoWidth,
      videoHeight: this.videoHeight,
      duration: this.duration,
      totalFrames: this.decoded,
      droppedFrames: this.dropped,
      stallSeeks: 0,
      stallReloads: 0,
      decoder: "webcodecs",
      decoded: this.decoded,
      dropped: this.dropped,
      queued: this.ready.length,
      decodeQueue: this.decoder?.decodeQueueSize ?? 0,
      stallResets: this.stallResets,
      color: this.color,
    };
  }

  /**
   * 退回旧播放器（`SceneVideos` 在 `onUnsupported` 里调）：交出脚本状态并释放自己。拆包期间脚本能改的只有这些——想放、loop、rate、
   * 结束回调、写过的 currentTime（还没有帧，时钟没走过，也不会结束）——所以换过去之后脚本看到的状态不变。
   */
  takeScriptState(): CodecScriptState {
    const state: CodecScriptState = {
      wantPlay: this.wantPlayValue,
      loop: this.loopValue,
      rate: this.rateValue,
      lastDrawn: this.lastDrawn,
      endedCallbacks: [...this.endedCallbacks],
      seekTo: this.pendingSeek,
    };
    this.dispose();
    return state;
  }

  /** 关掉全部帧、关解码器、丢掉预读；之后的调用都无效。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fresh = false;
    this.endedCallbacks.length = 0;
    this.release();
    this.settleFirstFrame();
  }

  // —— 内部：时钟 ——

  /** 时钟在走：出了第一帧、画到过、不在跳转、想放、宿主没暂停、没空闲、没结束。 */
  private get running(): boolean {
    return (
      !this.disposed &&
      !this.failed &&
      this.current !== null &&
      this.started &&
      !this.seeking &&
      this.wantPlayValue &&
      !this.hostPaused &&
      this.frame <= this.lastDrawn + IDLE_FRAMES &&
      !this.ended
    );
  }

  /** 媒体时间（秒）：展开的时钟减去绕过的遍数。 */
  private mediaTime(): number {
    return this.loops === 0 ? this.clock : this.clock - this.loops * this.duration;
  }

  /** 把上次结清以来的墙钟按当时的状态记进时钟；走到时长时绕回（loop）或停住并 `ended`。 */
  private advance(): void {
    const now = this.now();
    const elapsed = now - this.lastNow;
    this.lastNow = now;
    if (!(elapsed > 0) || !this.running) return;
    this.clock += (elapsed / 1000) * this.rateValue;
    const duration = this.duration;
    if (!(duration > 0)) return;
    if (this.loopValue) {
      if (this.clock - this.loops * duration >= duration) this.loops = Math.floor(this.clock / duration);
    } else if (this.clock - this.loops * duration >= duration) {
      this.clock = (this.loops + 1) * duration;
      this.ended = true;
    }
  }

  // —— 内部：挑帧 ——

  /** 显示时间 ≤ 媒体时间的最新一帧成为当前帧；越过的关掉并计丢帧。跳转中不挑（目标帧由 `onOutput` 直接换上）。 */
  private pick(): void {
    if (this.seeking || this.ready.length === 0) return;
    const nowUs = Math.round(this.clock * 1e6);
    // 结束时停在时长：下一遍的第一帧（时间戳正好是时长）不能换上
    const limit = this.ended ? nowUs - 1 : nowUs;
    let chosen = -1;
    while (chosen + 1 < this.ready.length && this.ready[chosen + 1].timestamp <= limit) chosen++;
    if (chosen < 0) return;
    for (let i = 0; i < chosen; i++) {
      this.ready[i].close();
      this.dropped++;
    }
    const next = this.ready[chosen];
    this.ready.splice(0, chosen + 1);
    this.current?.close();
    this.current = next;
    this.fresh = true;
  }

  // —— 内部：解码 ——

  private onOutput(frame: VideoFrame): void {
    if (this.disposed || this.failed) {
      frame.close();
      return;
    }
    const ts = frame.timestamp;
    const count = this.pending.get(ts);
    // reset 之前的残留（不在本次跳转的登记里）
    if (!count) {
      frame.close();
      return;
    }
    if (count === 1) this.pending.delete(ts);
    else this.pending.set(ts, count - 1);
    this.pendingCount--;
    this.decoded++;
    this.stallSince = this.now();
    if (this.seeking) {
      // 早于目标帧的输出丢掉（不算丢帧）；目标帧（或万一它没出来、第一个越过目标的帧）到了才换当前帧
      if (ts < this.seekTargetUs) frame.close();
      else {
        this.advance();
        this.seeking = false;
        this.current?.close();
        this.current = frame;
        this.fresh = true;
        if (!this.firstSeen) {
          this.firstSeen = true;
          this.settleFirstFrame();
        }
      }
      this.pump();
      return;
    }
    // 按时间戳插入（显示顺序输出时就是追加）
    let at = this.ready.length;
    while (at > 0 && this.ready[at - 1].timestamp > ts) at--;
    this.ready.splice(at, 0, frame);
    this.pump();
  }

  /**
   * 跳转到 `time`（秒）：时钟设为 `time`、遍数归零；解码器建好之前只记下来（`pendingSeek`）。之后 reset + configure，关掉已解出未显示的
   * 帧（当前帧留到目标帧到了再换），从显示时间 ≤ 目标帧的最近关键帧开始喂。
   */
  private seekTo(time: number): void {
    this.advance();
    this.clock = time;
    this.loops = 0;
    this.ended = false;
    if (this.failed) return;
    const decoder = this.decoder;
    const track = this.track;
    const config = this.config;
    if (!decoder || !track || !config) {
      this.pendingSeek = time;
      return;
    }
    for (const frame of this.ready) frame.close();
    this.ready = [];
    this.pending.clear();
    this.pendingCount = 0;
    this.flushed = false;
    this.feedLoop = 0;
    try {
      if (this.opened) decoder.reset();
      decoder.configure(config);
      this.opened = true;
    } catch (error) {
      this.fail("场景视频解码器配置失败", error);
      return;
    }
    const target = this.targetSample(time);
    this.seekTargetUs = Math.round(track.times[target] * 1e6);
    this.feedIndex = this.keyBefore(target);
    this.seeking = true;
    this.stallSince = this.now();
    this.pump();
  }

  /** 显示时间 ≤ `time` 的最新样本（按显示时间二分）；全都晚于 `time` 时取显示时间最早的。 */
  private targetSample(time: number): number {
    const { times } = this.track!;
    const order = this.displayOrder;
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (times[order[mid]] <= time) lo = mid + 1;
      else hi = mid;
    }
    return order[Math.max(0, lo - 1)];
  }

  /** 目标样本之前（解码顺序，含它自己）显示时间不晚于它的最近关键帧；没有时第一个关键帧。 */
  private keyBefore(target: number): number {
    const { keys, times } = this.track!;
    for (let i = target; i >= 0; i--) if (keys[i] && times[i] <= times[target]) return i;
    return this.firstKey;
  }

  /** 在流控上限内按解码顺序喂；到结尾时 loop 就接着喂下一遍（时间戳加一遍时长），否则 flush 取出最后几帧。 */
  private pump(): void {
    const decoder = this.decoder;
    const track = this.track;
    if (!decoder || !track || this.failed || this.disposed) return;
    this.starved = false;
    const count = track.sizes.length;
    const durationUs = this.duration > 0 ? this.duration * 1e6 : 0;
    while (decoder.decodeQueueSize + this.ready.length < MAX_AHEAD) {
      if (this.feedIndex >= count) {
        if (!this.loopValue || durationUs === 0) {
          if (!this.flushed) {
            this.flushed = true;
            // reset 会让在途的 flush 以 AbortError 结束，不是错误
            decoder.flush().catch(() => {});
          }
          return;
        }
        this.feedIndex = this.firstKey;
        this.feedLoop++;
        this.flushed = false;
      }
      const block = this.blockFor(this.feedIndex);
      if (!block) {
        this.starved = true;
        return;
      }
      const i = this.feedIndex;
      const offset = track.offsets[i] - block.base;
      const timestamp = Math.round(this.feedLoop * durationUs + track.times[i] * 1e6);
      try {
        decoder.decode({
          type: track.keys[i] ? "key" : "delta",
          timestamp,
          data: block.bytes!.subarray(offset, offset + track.sizes[i]),
        });
      } catch (error) {
        this.fail("场景视频解码失败", error);
        return;
      }
      this.pending.set(timestamp, (this.pending.get(timestamp) ?? 0) + 1);
      this.pendingCount++;
      this.feedIndex++;
    }
  }

  // —— 内部：预读 ——

  /** 样本 `i` 所在的块（读完了才返回）；喂过去的块丢掉，保证正在喂的一块之后还有预读的下一块（至多两块）。 */
  private blockFor(i: number): Block | null {
    while (this.blocks.length > 0 && !(this.blocks[0].from <= i && i < this.blocks[0].to)) this.blocks.shift();
    if (this.blocks.length === 0) this.blocks.push(this.loadBlock(i));
    if (this.blocks.length === 1) {
      const next = this.nextBlockStart(this.blocks[0]);
      if (next !== null) this.blocks.push(this.loadBlock(next));
    }
    const block = this.blocks[0];
    return block.bytes ? block : null;
  }

  /** 块之后接着喂的样本：到结尾时 loop 接第一个关键帧，否则没有。 */
  private nextBlockStart(block: Block): number | null {
    const count = this.track!.sizes.length;
    if (block.to < count) return block.to;
    return this.loopValue ? this.firstKey : null;
  }

  /** 从样本 `from` 起按解码顺序连续取样本，字节跨度不超过一块（至少一个样本），读进来。 */
  private loadBlock(from: number): Block {
    const { offsets, sizes } = this.track!;
    let start = offsets[from];
    let end = start + sizes[from];
    let to = from + 1;
    for (; to < sizes.length; to++) {
      const s = Math.min(start, offsets[to]);
      const e = Math.max(end, offsets[to] + sizes[to]);
      if (e - s > this.blockBytes) break;
      start = s;
      end = e;
    }
    const block: Block = { from, to, base: start, bytes: null };
    this.read(start, end).then(
      (bytes) => {
        // 跳转、失败、释放之后丢掉的块：结果不要了
        if (this.disposed || this.failed || !this.blocks.includes(block)) return;
        if (bytes.length !== end - start) {
          this.fail("场景视频读取失败", `长度不符：读到 ${bytes.length} 字节，应为 ${end - start}`);
          return;
        }
        block.bytes = bytes;
        this.pump();
      },
      (error: unknown) => {
        if (!this.disposed && !this.failed && this.blocks.includes(block)) this.fail("场景视频读取失败", error);
      },
    );
    return block;
  }

  // —— 内部：卡住 ——

  /**
   * 画到时看（同旧播放器的 `watchStall` 只在被画到时判断，宿主暂停、空闲、脚本暂停都自然不进判断）：想放、宿主没暂停、没空闲、没结束、
   * 在放或在跳转，没有已解出的帧、解码器有待解的输入、喂帧不在等读盘，持续 `STALL_MS` 没有任何输出 → reset 并从当前媒体时间重新跳转。
   * 离上一次判断已过 `STALL_MS`（中间没画到）时从现在重新计时，只算连续看着的那段。
   */
  private watchStall(): void {
    if (this.disposed || this.failed || !this.decoder) return;
    const now = this.now();
    if (now - this.stallSeen >= STALL_MS) this.stallSince = now;
    this.stallSeen = now;
    const stalling =
      this.wantPlayValue &&
      !this.hostPaused &&
      this.frame <= this.lastDrawn + IDLE_FRAMES &&
      !this.ended &&
      (this.seeking || this.running) &&
      this.ready.length === 0 &&
      this.pendingCount > 0 &&
      !this.starved;
    if (!stalling) {
      this.stallSince = now;
      return;
    }
    if (now - this.stallSince < STALL_MS) return;
    this.stallResets++;
    const time = this.mediaTime();
    this.report.warn(
      `场景视频解码器 ${STALL_MS} ms 没有输出，重置后从当前位置接着解：${this.source.path}`,
      `媒体时间 ${time} s，已解 ${this.decoded} 帧，待解 ${this.pendingCount} 个`,
    );
    this.seekTo(time);
  }

  // —— 内部：其它 ——

  private fireEnded(): void {
    for (const callback of [...this.endedCallbacks]) {
      try {
        callback();
      } catch (error) {
        this.report.warn(`场景视频的结束回调出错：${this.source.path}`, error);
      }
    }
  }

  private fail(message: string, detail: unknown): void {
    if (this.failed || this.disposed) return;
    this.advance();
    this.failed = true;
    this.fresh = false;
    // 同旧播放器：WPE 探测失败不置「想放」、播放出错清掉 `P+0x90`（rea 第 7 节）；之后脚本 play() 照常置真
    this.wantPlayValue = false;
    this.report.warn(
      `${message}，图层保持透明：${this.source.path} [${this.source.start}, ${this.source.end})`,
      detail,
    );
    this.release();
    this.settleFirstFrame();
  }

  private release(): void {
    this.current?.close();
    this.current = null;
    for (const frame of this.ready) frame.close();
    this.ready = [];
    this.blocks = [];
    this.pending.clear();
    this.pendingCount = 0;
    this.seeking = false;
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) {
      try {
        decoder.close();
      } catch {
        // 已经关了（出错的解码器）
      }
    }
  }

  private settleFirstFrame(): void {
    const waiters = this.firstFrameWaiters;
    this.firstFrameWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private warnRate(message: string, detail?: unknown): void {
    if (this.rateWarned) return;
    this.rateWarned = true;
    this.report.warn(message, detail);
  }
}
