/**
 * 场景视频纹理的播放器（P9a 步骤 1）：一段视频一个 `VideoTexturePlayer`，管 Blob、`<video>`、新帧标志与「最近一次被画到的帧号」。
 * 场景级的复用、帧号与宿主暂停在 `sceneVideos.ts`；GPU 一侧只经 `VideoSink` 拿元素，不知道播放器的存在。WPE 语义见 p9-REPORT
 * 「结论」与 rea-p9-video 第 3、4、6、7 节。
 *
 * - **字节**：按磁盘上的绝对区间 `fetch(file:, Range)` 再 `Response.blob()`。不读成 ArrayBuffer：最大一段 674 MiB，Blob 由 Chromium 换到
 *   磁盘、不经过 JS 堆（p9-REPORT 结论 10）。`file:` 的区间请求实测回 200 而不是 206，但只给区间，所以只核对长度。
 * - **元素**：`muted`（WPE 带 `FORCEMUTE` 创建，视频纹理不出声，rea 第 5 节）、`playsInline`、`loop` 缺省为真、`preload = "auto"`；
 *   用元素自己的时钟（WPE 用媒体引擎的实时时钟，不读 `g_Time`，rea 第 3 节）。挂进宿主页面的最上层、几乎看不见（`attachToDocument`，P9b 步骤 3）：
 *   看不见的视频由 Chromium 后台渲染驱动，暂停后恢复的第一帧要等约 255 ms。
 * - **新帧**：`requestVideoFrameCallback` 每次回调置 `fresh` 并重新登记（没有这个方法时只靠事件），`loadeddata`、`seeked` 也置位。
 *   GpuScene 画到这张纹理时才拷，对应 WPE「绑定纹理时有新帧才 `TransferVideoFrame`」（rea 第 2 节）。
 * - **该不该在放**：`wantPlay && !宿主暂停 && !失败 && 帧号 ≤ lastDrawn + 30`，对应 WPE 工作线程的「应当在放」
 *   `P+0x90 && P+0x60 + 30 ≥ 帧号`（rea 第 4 节）；只在结论变化时调 `play()` / `pause()`，不追赶时间。
 * - **失败**：读不到、长度不符、元素 `error`：标为失败、不再交出元素（纹理保持全 0，图层透明，同 WPE，rea 第 7、8 节），记一条 warn，
 *   并清掉 `wantPlay`（WPE 探测失败不置「想放」、播放出错清掉它）。WPE 自己不写日志，我们多记一条便于排查。
 * - **脚本接口**（P9b）：`rate`、`loop`、`currentTime`、`duration`、`play` / `pause` / `stop`、`isPlaying`、结束回调是脚本
 *   `IVideoTexture`（`script/api.ts`）的落点，宿主按视频区间从 `SceneVideos.playerFor` 现取。分工：这里管语义（WPE 的 P，rea 第 6 节、
 *   p9-REPORT「脚本 API」与「P9b 步骤 0 的补测」）——时长取容器时长、结束时报容器时长、脚本暂停 / 停止期间不交帧、失败后 `play()`
 *   仍置「想放」；包装对象管 WPE 脚本层的取值（`rate` / `loop` 字段、float32、`loop` 读出数字、参数转换、结束回调进脚本上下文）。
 */
import { fileToUrl } from "../fileUrl";

/** 视频在磁盘上的位置：散 `.tex` 或 `scene.pkg` 的绝对区间 `[start, end)`（编译期给出，P9a 步骤 2）。 */
export interface SceneVideoSource {
  path: string;
  start: number;
  end: number;
  /** 容器时长（秒，`containerDuration`，编译期读）；读不出时没有，播放器退回元素的时长（P9b）。 */
  duration?: number;
}

export interface VideoReport {
  warn(message: string, detail?: unknown): void;
}

/** 浏览器对象的工厂：测试注入替身，缺省用浏览器的。 */
export interface VideoFactories {
  createElement?: () => HTMLVideoElement;
  /** 把元素挂进页面，返回撤下它的函数（缺省 `attachToDocument`）。 */
  attach?: (element: HTMLVideoElement) => () => void;
  readBlob?: (source: SceneVideoSource) => Promise<Blob>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export interface VideoPlayerOptions extends VideoFactories {
  report: VideoReport;
}

/** dev 探针：一段视频的状态。 */
export interface VideoPlayerProbe {
  path: string;
  start: number;
  end: number;
  currentTime: number;
  paused: boolean;
  wantPlay: boolean;
  lastDrawn: number;
  fresh: boolean;
  failed: boolean;
  videoWidth: number;
  videoHeight: number;
  duration: number;
  /** `getVideoPlaybackQuality()` 的总帧数 / 丢帧数，拿不到时 null（p9-REPORT 提到它在循环点上不可信，只作参考）。 */
  totalFrames: number | null;
  droppedFrames: number | null;
}

/** 纹理连续这么多个渲染帧没被画到就暂停（WPE 常量，rea 第 4 节；实测第 32 帧冻住，差的是工作线程的延迟）。 */
export const IDLE_FRAMES = 30;

/** `setCurrentTime` 读回钳到 `[0, duration − 0.005]`（p9-REPORT「脚本 API」：钳制发生在媒体引擎里，脚本看得到）。 */
export const SEEK_END_MARGIN = 0.005;

/** `HTMLMediaElement.HAVE_CURRENT_DATA`（Node 里没有这个全局，单测用替身时也不依赖它）。 */
const HAVE_CURRENT_DATA = 2;

/** 复用播放器的键：同一文件的同一区间就是同一段视频。 */
export function videoSourceKey(source: SceneVideoSource): string {
  return `${source.path}\n${source.start}\n${source.end}`;
}

/** 挂进页面的视频元素的标记（`attachToDocument` 按它数已挂的个数、错开位置）。 */
const ATTACHED_MARK = "data-kb-video-texture";

/**
 * 把视频元素挂进宿主页面：左上角 2 px、1% 不透明度、放在最上层、不接收指针（P9b 步骤 3）。
 *
 * 看不见的视频由 Chromium 视频合成器的后台渲染驱动，约 250 ms 才更新一次当前帧：暂停一两秒后恢复播放，第一帧要等约 255 ms，这期间纹理
 * 停在暂停时的那一帧，之后一下跳到跟上的位置。WPE 恢复时是连续接着放的。多段视频的脚本切换、P9a 的「30 帧没画到就暂停、再画到时恢复」
 * 都会碰到。「看不见」包括三种（phase-9b「步骤 3」的对照，同一段视频暂停 2 s 再放、量到第一次 `requestVideoFrameCallback`）：
 * - 不挂 DOM（P9a 起的做法）：252–257 ms；
 * - `opacity: 0`：多数 253–257 ms；
 * - 挂上、1% 不透明但被场景的 WebGPU 画布整个盖住（合成器把被不透明图层盖住的图层裁掉不画）：宿主里 12 次恢复 6 次约 255 ms。
 * 放到画布上面之后 12 次都是 6–28 ms。
 *
 * 混进画面的只有左上角 2×2 像素、1% 不透明：8 位输出里最多差 3 级。多段视频按已挂的个数横向错开 2 px，不叠在一起加深。
 * 没有 `document.body` 时（Node 单测、宿主测试替身）不挂。
 */
export function attachToDocument(element: HTMLVideoElement): () => void {
  const body = typeof document === "undefined" ? undefined : document.body;
  if (!body) return () => {};
  const index = body.querySelectorAll(`[${ATTACHED_MARK}]`).length;
  Object.assign(element.style, {
    position: "fixed",
    left: `${2 * index}px`,
    top: "0px",
    width: "2px",
    height: "2px",
    opacity: "0.01",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  element.setAttribute(ATTACHED_MARK, "");
  element.setAttribute("aria-hidden", "true");
  element.disablePictureInPicture = true;
  body.appendChild(element);
  return () => element.remove();
}

/** 缺省的读法：按区间 `fetch(file:)` 直接取 Blob。CEF 的 `file:` 响应是 200、不带 Content-Range，所以只认长度。 */
export async function fetchVideoBlob(source: SceneVideoSource): Promise<Blob> {
  const { path, start, end } = source;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
    throw new RangeError(`视频区间无效：[${start}, ${end})`);
  const response = await fetch(fileToUrl(path), { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!response.ok) throw new TypeError(`读取视频失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (blob.size !== end - start)
    throw new Error(`视频长度不符：读到 ${blob.size} 字节，应为 ${end - start}（Range 被忽略？）`);
  return blob;
}

function describeError(error: unknown): unknown {
  // MediaError 转字符串只有「[object MediaError]」，换成码与消息
  if (error && typeof error === "object" && "code" in error && !(error instanceof Error)) {
    const media = error as { code: number; message?: string };
    return `MediaError ${media.code}${media.message ? `：${media.message}` : ""}`;
  }
  return error;
}

function isAbort(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

export class VideoTexturePlayer {
  /** 想放（WPE 的 `P+0x90`）：缺省为真；脚本的 play / pause / stop、宿主恢复、loop 为假时的结束与失败改它。 */
  wantPlay = true;
  /** 最近一次被画到的渲染帧号（WPE 的 `P+0x60`）。建好时取当前帧号：一开始就不可见的图层也先播 30 帧（WPE `SetTarget` 时写）。 */
  lastDrawn: number;
  /** 有还没拷进纹理的新帧。 */
  fresh = false;
  failed = false;
  readonly element: HTMLVideoElement;

  private readonly report: VideoReport;
  private readonly revokeObjectUrl: (url: string) => void;
  /** Blob 的对象地址；读完之前为 null，这期间不碰元素的 play / pause。 */
  private url: string | null = null;
  private frameHandle: number | null = null;
  /** 把元素从页面撤下（`attachToDocument` 的返回值），释放时调一次。 */
  private detach: () => void;
  private disposed = false;
  /** 已出过第一帧（`loadeddata`）。 */
  private loaded = false;
  private firstFrameWaiters: (() => void)[] = [];
  /** 上一次 `apply` 交来的帧号与宿主暂停；P9b 的 play / pause 立即按它们重算。 */
  private frame: number;
  private hostPaused = false;
  /** 上一次的结论（元素被要求在放）：只在变化时调 play / pause。 */
  private playing = false;
  private playWarned = false;
  private rateWarned = false;
  private loopValue = true;
  private rateValue = 1;
  private readonly endedCallbacks: (() => void)[] = [];
  /** 结束回调的判定状态，对应 WPE 脚本包装的 `V+0xf0`（上次读到的时间）与 `V+0xf4`（可触发），rea 第 6 节。 */
  private lastTime = 0;
  private armed = true;

  constructor(
    readonly source: SceneVideoSource,
    frame: number,
    options: VideoPlayerOptions,
  ) {
    this.report = options.report;
    this.lastDrawn = frame;
    this.frame = frame;
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    const element = options.createElement ? options.createElement() : document.createElement("video");
    this.element = element;
    element.muted = true;
    element.playsInline = true;
    element.loop = this.loopValue;
    element.preload = "auto";
    element.addEventListener("loadeddata", () => {
      if (this.disposed || this.failed) return;
      this.loaded = true;
      this.fresh = true;
      this.settleFirstFrame();
    });
    element.addEventListener("seeked", () => {
      if (!this.disposed && !this.failed) this.fresh = true;
    });
    element.addEventListener("error", () => this.fail("场景视频解码失败", describeError(element.error)));
    // 挂进页面（P9b 步骤 3）：看不见的视频暂停后恢复要等后台渲染约 255 ms 才出第一帧
    this.detach = (options.attach ?? attachToDocument)(element);
    this.watchFrames();

    const read = options.readBlob ?? fetchVideoBlob;
    const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
    const length = source.end - source.start;
    // 注入的读取函数同步抛错也走失败分支
    new Promise<Blob>((resolve) => resolve(read(source))).then(
      (blob) => {
        if (this.disposed || this.failed) return;
        // 注入的读取函数同样核对长度：区间被忽略时拿到的是整个文件，喂给元素只会解出错的东西
        if (blob.size !== length) {
          this.fail("场景视频读取失败", `长度不符：读到 ${blob.size} 字节，应为 ${length}`);
          return;
        }
        this.url = createObjectUrl(blob);
        element.src = this.url;
        this.sync();
      },
      (error: unknown) => this.fail("场景视频读取失败", error),
    );
  }

  /** 按 wantPlay、空闲（30 帧没画到）、宿主暂停三者算出元素该不该在放，只在变化时调 play() / pause()。 */
  apply(frame: number, hostPaused: boolean): void {
    if (this.disposed) return;
    this.frame = frame;
    this.hostPaused = hostPaused;
    this.sync();
  }

  /**
   * GpuScene 画到这张纹理：记帧号；空闲暂停中的立即恢复（只 `play()`，不改 `currentTime`，WPE 不追赶，rea 第 4 节）。
   * 有新帧就交出元素并清标志，同一帧再画到不再交出。
   */
  drawn(frame: number, hostPaused: boolean): HTMLVideoElement | null {
    if (this.disposed) return null;
    this.lastDrawn = frame;
    this.apply(frame, hostPaused);
    // 脚本暂停 / 停止期间不取帧：seek 读回会变、画面不变，到 play() 之后第一次画到才换（P9b 步骤 0，WPE 的 pause 结束并 join 工作线程，
    // 不再 `TransferVideoFrame`）；标志留着。空闲暂停与宿主暂停时 wantPlay 仍为真，照常交帧，同 WPE 工作线程照常取帧
    if (!this.fresh || this.failed || !this.wantPlay) return null;
    this.fresh = false;
    return this.element;
  }

  /**
   * 每个实时帧开头由 `SceneVideos.beginFrame` 调一次（在 `apply` 之前）：照 WPE 图层更新尾部的结束回调判定（rea 第 6 节，
   * `FUN_1401fdf90`）。不靠 `ended` 事件：`loop` 为真时它不触发。WPE 的判定不看可见性，这里也是每帧都做。
   * - `loop` 为真：读到的时间比上次在这个分支里读到的小（绕回）就触发；`setCurrentTime` / `stop` 造成的回退不算（它们清 `armed`）。
   *   上次的时间只在这个分支里更新，同 WPE 的 `V+0xf0`。
   * - `loop` 为假：`ended` 变真的那一帧触发一次，并清 `wantPlay`（WPE 的 `ENDED` 事件清 `P+0x90`）；不再 ended 之后重新装上。
   */
  detectEnd(): void {
    if (this.disposed || this.failed) return;
    const element = this.element;
    if (this.loopValue) {
      const time = element.currentTime;
      if (this.lastTime > time && this.armed) this.fireEnded();
      this.armed = true;
      this.lastTime = time;
    } else if (element.ended) {
      if (this.armed) {
        this.armed = false;
        this.wantPlay = false;
        this.fireEnded();
      }
    } else this.armed = true;
  }

  /** 第一帧到了（`loadeddata` 之后或 `readyState ≥ HAVE_CURRENT_DATA`）。 */
  get hasFirstFrame(): boolean {
    return this.loaded || (this.url !== null && this.element.readyState >= HAVE_CURRENT_DATA);
  }

  /** 出了第一帧、失败或释放时 resolve，不 reject。 */
  firstFrame(): Promise<void> {
    if (this.hasFirstFrame || this.failed || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.firstFrameWaiters.push(resolve));
  }

  // —— 脚本接口（`IVideoTexture` 的落点，P9b；rea 第 6 节）——

  /** 播放速率。写入同时转给 `defaultPlaybackRate` 与 `playbackRate`（WPE 同时调 `SetDefaultPlaybackRate` 与 `SetPlaybackRate`；
   *  设 src 时的加载算法会把 `playbackRate` 重置成 `defaultPlaybackRate`，只写一个会丢）。 */
  get rate(): number {
    return this.rateValue;
  }

  set rate(value: number) {
    if (this.disposed) return;
    let rate = value;
    // WPE 不钳制，负数让工作线程的等待变成约 49 天、等于卡死（rea 第 3 节第 4 条）；不复刻，钳到 0（停住）
    if (!(rate >= 0)) {
      this.warnRate(`场景视频的 rate 不能为负（${value}），按 0：${this.source.path}`);
      rate = 0;
    }
    this.rateValue = rate;
    try {
      // 先写 playbackRate：只有它会拒收，拒收时两个都不动
      this.element.playbackRate = rate;
      this.element.defaultPlaybackRate = rate;
    } catch (error) {
      // Chromium 只收 0 与 [0.0625, 16]，超出时抛 NotSupportedError；WPE 的 MF 不支持的速率静默失败（推断），这里保留原速率
      this.warnRate(`场景视频不支持这个 rate（${rate}），保持原速率：${this.source.path}`, error);
    }
  }

  get loop(): boolean {
    return this.loopValue;
  }

  set loop(value: boolean) {
    if (this.disposed) return;
    this.loopValue = value;
    this.element.loop = value;
  }

  get currentTime(): number {
    const element = this.element;
    // 结束时 Chromium 停在它自己的时长（各轨编辑之后），WPE 停在容器时长，读回正好等于 `duration`（P9b 步骤 0）：脚本拿它和
    // `duration` 比，所以报容器时长
    if (element.ended && this.source.duration !== undefined) return this.source.duration;
    return element.currentTime;
  }

  /**
   * 钳到 `[0, max(0, duration − 0.005)]`，上界按容器时长（`this.duration`），元素自己再按它的时长钳；duration 不是有限数时只钳下界
   * （p9-REPORT「脚本 API」实测）。
   */
  set currentTime(value: number) {
    if (this.disposed) return;
    let time = value > 0 ? value : 0;
    const duration = this.duration;
    if (Number.isFinite(duration)) time = Math.min(time, Math.max(0, duration - SEEK_END_MARGIN));
    // WPE 的 setCurrentTime：loop 下清 `V+0xf4`，自己造成的回退不当成绕回
    if (this.loopValue) this.armed = false;
    this.element.currentTime = time;
  }

  /**
   * 容器时长（WPE 的 `GetDuration`，编译期读的 `source.duration`，P9b 点 1），读不出时退回元素的（元数据之前 NaN）。Chromium 按各轨
   * 编辑之后算（2.516667、9.983333），WPE 是容器时长（2.517、10.005333）。
   */
  get duration(): number {
    return this.source.duration ?? this.element.duration;
  }

  /** WPE：`if (isEnded) setCurrentTime(0); play()`。只改意图，元素由 `apply` 的结论去放（同 WPE 由工作线程去 Play）。 */
  play(): void {
    if (this.disposed) return;
    if (this.element.ended) this.element.currentTime = 0;
    this.wantPlay = true;
    this.sync();
  }

  /** WPE 的 pause 直接停引擎：`isPlaying` 立即为假，时间停住。 */
  pause(): void {
    if (this.disposed) return;
    this.wantPlay = false;
    this.sync();
  }

  /** WPE：`pause()` + `setCurrentTime(0)`，之后 `isPlaying` 为假。 */
  stop(): void {
    if (this.disposed) return;
    this.pause();
    this.currentTime = 0;
  }

  /**
   * `wantPlay && !已结束`（WPE：`P+0x90 && !IsEnded`）：空闲暂停与宿主暂停期间仍为真，同 WPE（`P+0x90` 不变，rea 第 4 节）。
   * 不看 `failed`：失败时 `fail` 清掉 wantPlay，之后脚本 `play()` 照常置真、isPlaying 为真但没有帧（WPE 探测失败同样如此，rea 第 7 节）。
   */
  isPlaying(): boolean {
    return !this.disposed && this.wantPlay && !this.element.ended;
  }

  /**
   * 「清空脚本存储」重启脚本时（宿主 `restartScriptsWithClearedStorage`，经 `SceneVideos.resetScriptState`）：脚本改过的状态恢复成
   * 建好时的样子——结束回调清空（旧脚本已停止、回调不会再调，留着只会拖住旧的脚本环境，重启一次多一批）、`loop` 真、`rate` 1、想放
   * （失败的除外，同 `fail`），结束判定重新装上。新脚本拿到的 `IVideoTexture` 字段是缺省值，这样两边一致。不 seek、不重读，
   * 视频从当前位置接着放（同重编译不打断，P9a 决定 2）。WPE 没有这个操作，是我们自己的。
   */
  resetScriptState(): void {
    if (this.disposed) return;
    this.endedCallbacks.length = 0;
    this.loop = true;
    this.rate = 1;
    this.lastTime = 0;
    this.armed = true;
    this.wantPlay = !this.failed;
    this.sync();
  }

  /** WPE 的 `addEndedCallback`：不去重，没有删除接口；回调不带参数。 */
  addEndedCallback(callback: () => void): void {
    if (!this.disposed) this.endedCallbacks.push(callback);
  }

  probe(): VideoPlayerProbe {
    const element = this.element;
    let quality: VideoPlaybackQuality | null = null;
    try {
      quality = typeof element.getVideoPlaybackQuality === "function" ? element.getVideoPlaybackQuality() : null;
    } catch {
      quality = null;
    }
    return {
      path: this.source.path,
      start: this.source.start,
      end: this.source.end,
      currentTime: element.currentTime,
      paused: element.paused,
      wantPlay: this.wantPlay,
      lastDrawn: this.lastDrawn,
      fresh: this.fresh,
      failed: this.failed,
      videoWidth: element.videoWidth,
      videoHeight: element.videoHeight,
      duration: element.duration,
      totalFrames: quality?.totalVideoFrames ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
    };
  }

  /** 停元素、清 src、撤销对象地址、取消帧回调；之后的调用都无效。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fresh = false;
    this.endedCallbacks.length = 0;
    // 失败时已经释放过
    if (!this.failed) this.release();
    this.settleFirstFrame();
  }

  private sync(): void {
    if (this.disposed || this.failed || this.url === null) return;
    const want = this.wantPlay && !this.hostPaused && this.frame <= this.lastDrawn + IDLE_FRAMES;
    if (want === this.playing) return;
    this.playing = want;
    if (!want) {
      this.element.pause();
      return;
    }
    const played = this.element.play();
    // 紧跟着的 pause 打断 play 是正常的（AbortError）；静音视频一般不会被自动播放策略拦，真被拦只记一次。已经失败的（解码出错时
    // play() 必然被拒，NotSupportedError）由 `fail` 记过一条，这里不再重复
    played?.catch?.((error: unknown) => {
      if (isAbort(error) || this.disposed || this.failed || this.playWarned) return;
      this.playWarned = true;
      this.report.warn(`场景视频播放失败：${this.source.path}`, error);
    });
  }

  private watchFrames(): void {
    const element = this.element;
    if (typeof element.requestVideoFrameCallback !== "function") return;
    this.frameHandle = element.requestVideoFrameCallback(() => {
      this.frameHandle = null;
      if (this.disposed || this.failed) return;
      this.fresh = true;
      this.watchFrames();
    });
  }

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
    this.failed = true;
    this.fresh = false;
    // WPE 探测失败不置「想放」（`Open` 里的 play() 在成功分支）、播放出错先清 `P+0x90`（rea 第 7 节）；之后脚本 play() 照常置真。
    // 宿主恢复（`SceneVideos.setPaused(false)`）也会把它置真，同 WPE 对每个有播放器的纹理调 play()
    this.wantPlay = false;
    this.report.warn(
      `${message}，图层保持透明：${this.source.path} [${this.source.start}, ${this.source.end})`,
      detail,
    );
    this.release();
    this.settleFirstFrame();
  }

  private release(): void {
    const element = this.element;
    if (this.frameHandle !== null) {
      if (typeof element.cancelVideoFrameCallback === "function") element.cancelVideoFrameCallback(this.frameHandle);
      this.frameHandle = null;
    }
    this.playing = false;
    element.pause();
    element.removeAttribute("src");
    element.load();
    this.detach();
    this.detach = () => {};
    if (this.url !== null) {
      this.revokeObjectUrl(this.url);
      this.url = null;
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
