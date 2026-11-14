/**
 * 用户纹理的来源表（P11b 步骤 2，rea-p11-textures 第 1、2 节，p11-REPORT「属性纹理」、M7–M9）。
 *
 * 宿主持有一份：按属性名存当前值；值变了异步读文件、解码，解码完成通知宿主（`onReady`），渲染器下一帧 `sync` 换上。渲染器经
 * {@link UserTextureProvider} 只读：给参考尺寸，拿到「源图 + 裁切矩形 + WPE 的纹理名」，GPU 纹理由渲染器按纹理名缓存与释放。
 * 状态只存解码后的整张源图（`ImageBitmap` 加可选的 gamma 表），不存 GPU 资源，所以重编译、换场景都不丢缓存。
 *
 * - **取值**：值是绝对路径（后端统一成 `/` 分隔，`fileToUrl` 负责转 `file:` 并编码）。空串、读不出、解码失败都记成「无图」，槽用缺省纹理，
 *   不保留上一张，只记一条 debug（WPE 的行为，p11-REPORT 结论 6）。
 * - **解码**（M7）：`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "from-image" })`，
 *   与 FreeImage 在 8 位 PNG、16 位 RGBA PNG、BMP、ICO 上逐像素相同；PNG 的 `gAMA` 照 libpng 的表校正（M9，表交给渲染器在 GPU 上查）。
 *   已知差异：JPEG 的色度上采样、16 位灰度 PNG 的拉伸。
 * - **竞态**：同一来源连续改值只认最后一次，后发先至的结果丢弃（关掉位图）。
 * - **缓存**：解码结果按「值」缓存最近 {@link DECODED_CACHE_SIZE} 张（来回切换不重复解码）；裁切矩形按 WPE 的纹理名记在解码结果上，
 *   同一个名字共用一张，按先请求的那个槽的精确比例裁（`crop`）。
 * - **GIF 与视频**（P11b 步骤 4，`.gif`、`.mp4 .wmv .avi .m4v .mov .mkv .webm`，扩展名转小写再判断，`mediaKind`；rea-p11b 第 2、3 节、
 *   p11-REPORT M5、M6）：帧状态也放在这里、跨重编译保留。WPE 的一个纹理名是一张纹理，GIF 的解码状态 / 视频的播放器因此按纹理名各一份
 *   （`MediaTexture`），`GpuScene` 只持有 GPU 纹理，画到时经 `UserTextureAnimation.drawn()` 要新内容、自己上传。
 *   - **按值登记、引用计数**（`Shared`）：不同属性名选了同一个文件共用一份（WPE 的纹理缓存按名字共享）；没有来源用这个值时释放（GIF 状态
 *     丢掉、播放器 `dispose`）。动图不进按值的解码缓存：WPE 换走再选回来是新纹理、从第 0 帧 / 视频开头重来（rea-p11b 2.4、3.4）。
 *   - **加载**：GIF 读字节、`openGif` 解出第 0 帧，尺寸 = 逻辑屏幕尺寸；视频读 Blob、建 `VideoTexturePlayer`（P9a 的类）等第一帧，尺寸取
 *     `videoWidth × videoHeight`；读不出、打不开、视频解码失败或没有尺寸都是 `failed`，槽用缺省纹理（同 WPE）。初始解出的那个 GIF / 播放器留给
 *     第一个请求的纹理名，后来的纹理名各自再开（同一份字节 / Blob）。
 *   - **推进**：GIF 只在画到时推进、每个渲染帧最多一次（帧号由 `beginFrame` 走，宿主暂停时不走）；视频的 30 帧规则与暂停同 `SceneVideos`。
 *     已知小差异：暂停期间改值新建的 GIF 第一次画到时用的是上一个实时帧的 frametime。HDR 视频（PQ / HLG，WPE 用 `rgba16float`）不做，照常 RGBA8。
 */
import { fileToUrl } from "../fileUrl";
import { GifAnimation } from "./gif";
import { cropRect, referenceRatio, textureKey, type CropRect } from "./crop";
import { pngGammaTable } from "./png";
import {
  SEEK_END_MARGIN,
  VideoTexturePlayer,
  type VideoFactories,
  type VideoPlayerProbe,
  type VideoReport,
} from "../video/player";

export interface UserTextureImage {
  width: number;
  height: number;
  /** 解码后的整张源图（`premultiplyAlpha: "none"`，直通 alpha）。 */
  source: ImageBitmap;
  /**
   * PNG `gAMA` 的 8 位校正表（256 项，`pngGammaTable`）；不需要校正时 null。不在 CPU 读回像素（2D 画布是预乘 alpha，半透明像素有舍入损失），
   * 由渲染器上传时在 GPU 上逐字节查表（`render/userGamma.ts`），对每个字节都精确。
   */
  gamma: Uint8Array | null;
}

/**
 * 一次要上传的内容：GIF 是整张画布（渲染器按 `rect` 取，`width` 是画布宽），视频是元素（按 `rect` 的源矩形拷，整像素起点；WPE 的 MF 在
 * 半像素起点时重采样，记为已知差异）。
 */
export type UserTextureFrame =
  { kind: "pixels"; data: Uint8Array; width: number; height: number } | { kind: "element"; element: HTMLVideoElement };

/** GIF / 视频的一张纹理（WPE 的一个纹理名）的帧来源：渲染器按它建 GPU 纹理、画到时要新内容。 */
export interface UserTextureAnimation {
  readonly kind: "gif" | "video";
  /** 建 GPU 纹理时的初始内容：GIF 是当前画布；视频是 null（全 0，同 WPE 的初始数据，等第一次 `drawn` 交帧）。 */
  current(): UserTextureFrame | null;
  /** 画到这张纹理（编码时每个绑定它的 draw 调一次）：照 WPE 推进，有还没交出过的新内容就交出（交出即清标志），否则 null。 */
  drawn(): UserTextureFrame | null;
}

/** 渲染器取到的一张裁好的用户图：WPE 的纹理名、（静态图的）解码后整张源图、在源图上的矩形（纹理尺寸 = 矩形宽高）。 */
export interface UserTextureCrop {
  key: string;
  rect: CropRect;
  /** 静态图的整张源图；GIF 与视频为 null（内容由 `animation` 给）。 */
  image: UserTextureImage | null;
  /** GIF 与视频：同一个值、同一个纹理名在值没换过时是同一个对象；值换过之后是新对象（WPE 从头开始）。静态图没有。 */
  animation?: UserTextureAnimation;
}

/** 渲染器一侧的接口：`GpuScene` 只认它，单测与 dev 探针可以换自己的实现。 */
export interface UserTextureProvider {
  /**
   * 属性来源 `name` 当前值的裁切；没有图（值为空、读不出、还在解码）时 null。`reference` 是槽的参考尺寸（比例取它），
   * null 表示 `keepaspect`、整张进纹理。
   */
  crop(name: string, reference: { width: number; height: number } | null): UserTextureCrop | null;
  /**
   * 每个实时帧开头（渲染器在视频帧号之后调，补画帧不调）：帧号 +1、记下本帧的 `g_Frametime`，视频按 30 帧规则暂停空闲的。
   * GIF 不在这里推进，只在画到时推进（`UserTextureAnimation.drawn`）。
   */
  beginFrame?(frametime: number): void;
}

export type UserTextureStatus = "none" | "loading" | "ready" | "empty" | "failed";

/** 可注入的外部依赖（单测用假的）。 */
export interface UserTextureDeps {
  /** 读文件字节（参数是属性值，即绝对路径）；失败抛错。 */
  read(path: string): Promise<Uint8Array>;
  /** 把文件字节解成位图（`createImageBitmap` 带三个参数）。 */
  decode(bytes: Uint8Array): Promise<ImageBitmap>;
  now(): number;
  /** 一条 debug 日志。 */
  log(message: string): void;
  /** 打开 GIF（建解码状态并解出第 0 帧，P11b 步骤 4）：缺省 `GifAnimation.open`；失败抛错。 */
  openGif(bytes: Uint8Array): GifSource;
  /** 读视频文件成 Blob（参数是属性值，即绝对路径）：缺省 `fetch(fileToUrl(path))`；失败抛错。 */
  readBlob(path: string): Promise<Blob>;
  /** 视频播放器的浏览器对象工厂（测试注入替身；`readBlob` 由来源表自己给，这里的会被覆盖）。 */
  videoFactories: VideoFactories;
  /** 视频播放器的 warning 出口（宿主传它的 report）。 */
  report: VideoReport;
}

/** `GifAnimation` 里来源表用到的部分（单测注入假的）。 */
export type GifSource = Pick<GifAnimation, "width" | "height" | "canvas" | "advance">;

/** dev 探针：一个来源的当前状态。 */
export interface UserTextureProbe {
  name: string;
  value: string;
  /** 值的媒体种类（`mediaKind`）。 */
  kind: MediaKind;
  status: UserTextureStatus;
  width?: number;
  height?: number;
  /** 最近一次解码的用时（毫秒，含读文件）。 */
  decodeMs?: number;
  /** 已登记的纹理名（`crop` 请求过的），按登记顺序。 */
  keys: string[];
  /** 视频：每个纹理名的播放器状态。 */
  videos?: { key: string; player: VideoPlayerProbe }[];
  /** GIF：每个纹理名换过几次帧（`frames`）与最近一次推进时的帧号（`lastFrame`，没推进过 −1）。 */
  gifs?: { key: string; frames: number; lastFrame: number }[];
}

/** 解码结果按值缓存的张数上限（正在被来源用着的不算在内，不会被换出）。 */
export const DECODED_CACHE_SIZE = 4;

/** 视频的扩展名（小写）。 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "wmv", "avi", "m4v", "mov", "mkv", "webm"]);

/** 路径的扩展名（小写，不含点）；没有时空串。 */
export function fileExtension(value: string): string {
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 值走哪种纹理：`gif` 是 GIF、`VIDEO_EXTENSIONS` 是视频，其余交给 `createImageBitmap`（rea-p11b 2.1、3.1，扩展名转小写）。 */
export type MediaKind = "image" | "gif" | "video";

export function mediaKind(value: string): MediaKind {
  const extension = fileExtension(value);
  if (extension === "gif") return "gif";
  return VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
}

/** 视频第一帧的等待上限：超时当失败，免得一个卡住的视频让加载（预解码）一直挂着。 */
export const VIDEO_FIRST_FRAME_TIMEOUT_MS = 10_000;
/** `seekVideos` 等 `seeked` 的上限。 */
const SEEK_TIMEOUT_MS = 5_000;

interface Decoded {
  image: UserTextureImage;
  /** 纹理名 → 矩形：先请求的槽定比例。 */
  rects: Map<string, CropRect>;
  decodeMs: number;
}

/** 帧号 / frametime / 宿主暂停：来源表写、各纹理读（GIF 的「每帧最多推进一次」、视频的 30 帧规则都靠它）。 */
interface Clock {
  frame: number;
  frametime: number;
  paused: boolean;
}

/** 一个 GIF 纹理名（rea-p11b 2.2）：画到时推进、每个渲染帧最多一次，换了帧才交出画布。 */
class GifTexture implements UserTextureAnimation {
  readonly kind = "gif";
  /** 最近一次推进时的来源表帧号；没推进过为 −1。 */
  lastFrame = -1;
  /** 画布有还没交出的变化。 */
  dirty = false;
  /** 换过几次帧（探针）。 */
  frames = 0;

  constructor(
    readonly gif: GifSource,
    private readonly clock: Clock,
  ) {}

  private pixels(): UserTextureFrame {
    return { kind: "pixels", data: this.gif.canvas, width: this.gif.width, height: this.gif.height };
  }

  /** 建 GPU 纹理时的初始内容：当前画布（已包含未交出的变化，所以清标志）。 */
  current(): UserTextureFrame {
    this.dirty = false;
    return this.pixels();
  }

  /** 照 WPE 推进：本帧推进过就不再推进；`advance` 用本帧的 frametime，换了帧置 `dirty`。解码出错当作没换帧（画布保持）。 */
  step(): void {
    const clock = this.clock;
    if (this.lastFrame === clock.frame) return;
    this.lastFrame = clock.frame;
    let changed = false;
    try {
      changed = this.gif.advance(clock.frametime);
    } catch {
      changed = false;
    }
    if (changed) {
      this.dirty = true;
      this.frames++;
    }
  }

  drawn(): UserTextureFrame | null {
    this.step();
    if (!this.dirty) return null;
    this.dirty = false;
    return this.pixels();
  }
}

/** 一个视频纹理名：一个播放器（规则同 P9a 的 `SceneVideos`：30 帧没画到暂停、再画到恢复）。 */
class VideoTexture implements UserTextureAnimation {
  readonly kind = "video";

  constructor(
    readonly player: VideoTexturePlayer,
    private readonly clock: Clock,
  ) {}

  /** 初值全 0（同 WPE 的初始数据）：等第一次 `drawn` 交帧。 */
  current(): null {
    return null;
  }

  drawn(): UserTextureFrame | null {
    const element = this.player.drawn(this.clock.frame, this.clock.paused);
    return element ? { kind: "element", element } : null;
  }
}

type MediaTexture = GifTexture | VideoTexture;

/**
 * 一个 GIF / 视频文件（按值登记、引用计数）：几个属性来源选了同一个文件时共用，没有来源用它时释放（`releaseShared`）。
 * 文件字节 / Blob 与初始解出的解码器 / 播放器放在这里，每个纹理名的帧状态在 `textures`。
 */
interface Shared {
  kind: "gif" | "video";
  value: string;
  /** 有几个来源在用（加载中也算，加载结果比引用晚到时靠它判断要不要丢）。 */
  refs: number;
  disposed: boolean;
  state: "loading" | "ready" | "failed";
  error: string;
  /** 加载结束（成功或失败）时 resolve，不 reject。 */
  ready: Promise<void>;
  /** GIF 的逻辑屏幕尺寸、视频的 `videoWidth × videoHeight`（ready 后有）。 */
  width: number;
  height: number;
  loadMs: number;
  bytes: Uint8Array | null;
  blob: Blob | null;
  /** 初始解出的 GIF / 播放器：留给第一个请求的纹理名，取走后 null。 */
  initialGif: GifSource | null;
  initialPlayer: VideoTexturePlayer | null;
  /** 纹理名 → 帧状态。 */
  textures: Map<string, MediaTexture>;
  rects: Map<string, CropRect>;
}

interface Entry {
  value: string;
  status: UserTextureStatus;
  /** 当前值的解码结果（静态图 ready 时有）。 */
  decoded: Decoded | null;
  /** 当前值的 GIF / 视频（认领之后一直有，直到换值）。 */
  shared: Shared | null;
  /** 请求序号：旧请求的结果比它小就丢弃。 */
  seq: number;
  decodeMs?: number;
}

function defaultDeps(read: (path: string) => Promise<Uint8Array>): UserTextureDeps {
  return {
    read,
    decode: (bytes) =>
      createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
        imageOrientation: "from-image",
      }),
    now: () => performance.now(),
    log: () => {},
    openGif: (bytes) => GifAnimation.open(bytes),
    readBlob: async (path) => {
      const response = await fetch(fileToUrl(path));
      if (!response.ok) throw new TypeError(`读取视频失败（HTTP ${response.status}）`);
      return response.blob();
    },
    videoFactories: {},
    report: { warn: () => {} },
  };
}

/**
 * `seekVideos` 的目标时刻：超过时长按时长取模（视频纹理缺省循环），再钳到 `[0, duration − SEEK_END_MARGIN]`；时长未知时只钳下界。
 * 同 `dev/videoProbe.ts` 的 `videoSeekTime`（来源表在产品代码里，不引 dev 模块，这里照抄）。
 */
function seekTarget(time: number, duration: number): number {
  const at = Math.max(0, time);
  if (!Number.isFinite(duration) || duration <= 0) return at;
  const looped = at >= duration ? at % duration : at;
  return Math.min(looped, Math.max(0, duration - SEEK_END_MARGIN));
}

/** `promise` 在 `ms` 毫秒内完成就原样返回，否则 reject（计时器在完成时清掉）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class UserTextureSources implements UserTextureProvider {
  /**
   * 来源的图换好了（解码完成，或值清空 / 失败回到缺省）：宿主把渲染器那边标脏、暂停时补画一帧。同步调用（缓存命中时在 `setValue` 里就调）。
   */
  onReady: ((name: string) => void) | null = null;
  private readonly deps: UserTextureDeps;
  private readonly entries = new Map<string, Entry>();
  /** 值 → 解码结果（最近使用在后）；只有静态图（动图不缓存，换走再选回来要从头开始）。 */
  private readonly cache = new Map<string, Decoded>();
  /** 值 → GIF / 视频（引用计数）。 */
  private readonly media = new Map<string, Shared>();
  private readonly inflight = new Set<Promise<void>>();
  /** 帧号、本帧 frametime 与宿主暂停（`beginFrame` / `setPaused`）：动图的帧状态共用。 */
  private readonly clock: Clock = { frame: 0, frametime: 0, paused: false };
  private disposed = false;

  /**
   * @param read 读文件字节：参数是属性值（绝对路径），宿主传 `FetchSceneReader.readWhole`（内部经 `fileToUrl` 转 `file:` 并编码）。
   * @param deps 其余依赖，测试传假的。
   */
  constructor(read: (path: string) => Promise<Uint8Array>, deps: Partial<UserTextureDeps> = {}) {
    this.deps = { ...defaultDeps(read), ...deps };
  }

  /** 来源当前的值；没设过为空串。 */
  current(name: string): string {
    return this.entries.get(name)?.value ?? "";
  }

  status(name: string): UserTextureStatus {
    return this.entries.get(name)?.status ?? "none";
  }

  /**
   * 设来源的值并开始异步解码。值没变什么都不做；变了：旧请求作废、旧值的 GIF / 视频放掉一份引用，空串当场记成无图，缓存命中当场换上，
   * 其余异步读文件解码（GIF / 视频同样，共用同一个值的已加载好的当场换上）。首次设空串也记一条（`status` 为 `empty`），不通知时机以外的差别。
   */
  setValue(name: string, value: string): void {
    if (this.disposed) return;
    const previous = this.entries.get(name);
    if (previous && previous.value === value) return;
    const entry: Entry = { value, status: "loading", decoded: null, shared: null, seq: (previous?.seq ?? 0) + 1 };
    this.entries.set(name, entry);
    if (previous?.shared) this.releaseShared(previous.shared);
    if (value === "") {
      entry.status = "empty";
      this.onReady?.(name);
      return;
    }
    const kind = mediaKind(value);
    if (kind !== "image") {
      this.attachMedia(name, entry, kind);
      return;
    }
    const cached = this.cache.get(value);
    if (cached) {
      // 最近使用：挪到后面
      this.cache.delete(value);
      this.cache.set(value, cached);
      entry.decoded = cached;
      entry.status = "ready";
      entry.decodeMs = 0;
      this.onReady?.(name);
      return;
    }
    const task: Promise<void> = this.load(name, entry).finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  /** 全部在途的解码都结束（成功、失败或被取代）。加载时预解码、确定性回放等它。 */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /** 批量设值并等全部结束：宿主加载时用，第一帧就是用户图。 */
  async prime(values: Iterable<readonly [string, string]>): Promise<void> {
    for (const [name, value] of values) this.setValue(name, value);
    await this.settled();
  }

  crop(name: string, reference: { width: number; height: number } | null): UserTextureCrop | null {
    const entry = this.entries.get(name);
    if (!entry || entry.status !== "ready") return null;
    const ratio = reference ? referenceRatio(reference.width, reference.height) : 0;
    const key = textureKey(entry.value, ratio);
    const shared = entry.shared;
    if (shared) {
      // GIF / 视频：裁切同静态图（rea-p11b 2.1、3.1 的取整相同），纹理名各一份帧状态
      let texture = shared.textures.get(key);
      if (!texture) {
        texture = this.makeTexture(shared) ?? undefined;
        if (!texture) return null;
        shared.textures.set(key, texture);
      }
      let rect = shared.rects.get(key);
      if (!rect) {
        rect = cropRect(shared.width, shared.height, ratio);
        shared.rects.set(key, rect);
      }
      return { key, rect, image: null, animation: texture };
    }
    const decoded = entry.decoded;
    if (!decoded) return null;
    let rect = decoded.rects.get(key);
    if (!rect) {
      rect = cropRect(decoded.image.width, decoded.image.height, ratio);
      decoded.rects.set(key, rect);
    }
    return { key, image: decoded.image, rect };
  }

  /**
   * 实时帧开头：帧号 +1、记 frametime，全部视频播放器按「30 帧没画到就暂停」重新判定（同 `SceneVideos.beginFrame`）。
   * GIF 不在这里推进（只在画到时推进）。
   */
  beginFrame(frametime: number): void {
    if (this.disposed) return;
    this.clock.frame++;
    this.clock.frametime = Number.isFinite(frametime) && frametime > 0 ? frametime : 0;
    for (const player of this.players()) player.apply(this.clock.frame, this.clock.paused);
  }

  /**
   * 宿主暂停或文档隐藏（同 `SceneVideos.setPaused`）：全部视频 `pause`；恢复时照 WPE 把所有播放器的 `wantPlay` 置真再放。
   * GIF 没有事可做：暂停时没有实时帧、帧号不走，也就不推进。
   */
  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.clock.paused) return;
    this.clock.paused = paused;
    const players = [...this.players()];
    if (!paused) for (const player of players) player.wantPlay = true;
    for (const player of players) player.apply(this.clock.frame, paused);
  }

  /**
   * dev 用（确定性回放）：对全部 GIF 纹理做一次推进（`drawn` 的推进部分，每个帧号最多一次），不清 `dirty`：
   * 之后真正画到时才上传这一次的结果。
   */
  advanceGifs(): void {
    for (const shared of this.media.values())
      for (const texture of shared.textures.values()) if (texture instanceof GifTexture) texture.step();
  }

  /**
   * dev 用（确定性回放）：把用户视频的播放器 seek 到 `timeOf(值)` 给的时刻（`undefined` 不动）：超过时长按循环取模再钳到
   * `[0, duration − 0.005]`，等 `seeked`（有超时），之后 `drawn` 交出那一帧。屏外渲染没有实时帧，视频不按真实时间放，帧来自 seek。
   */
  async seekVideos(timeOf: (value: string) => number | undefined): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const shared of this.media.values()) {
      if (shared.kind !== "video" || shared.state !== "ready") continue;
      const time = timeOf(shared.value);
      if (time === undefined) continue;
      for (const player of this.sharedPlayers(shared)) jobs.push(this.seek(player, time));
    }
    await Promise.all(jobs);
  }

  probe(): UserTextureProbe[] {
    return [...this.entries].map(([name, entry]) => {
      const shared = entry.shared;
      const size = shared
        ? shared.state === "ready"
          ? { width: shared.width, height: shared.height }
          : null
        : entry.decoded
          ? { width: entry.decoded.image.width, height: entry.decoded.image.height }
          : null;
      const textures = shared ? [...shared.textures] : [];
      return {
        name,
        value: entry.value,
        kind: mediaKind(entry.value),
        status: entry.status,
        ...(size ?? {}),
        ...(entry.decodeMs !== undefined ? { decodeMs: Math.round(entry.decodeMs * 100) / 100 } : {}),
        keys: shared ? [...shared.rects.keys()] : entry.decoded ? [...entry.decoded.rects.keys()] : [],
        ...(shared?.kind === "video"
          ? {
              videos: textures.flatMap(([key, texture]) =>
                texture instanceof VideoTexture ? [{ key, player: texture.player.probe() }] : [],
              ),
            }
          : {}),
        ...(shared?.kind === "gif"
          ? {
              gifs: textures.flatMap(([key, texture]) =>
                texture instanceof GifTexture ? [{ key, frames: texture.frames, lastFrame: texture.lastFrame }] : [],
              ),
            }
          : {}),
      };
    });
  }

  dispose(): void {
    this.disposed = true;
    this.onReady = null;
    for (const decoded of this.cache.values()) closeImage(decoded.image);
    this.cache.clear();
    for (const shared of this.media.values()) {
      shared.disposed = true;
      this.disposeShared(shared);
    }
    this.media.clear();
    this.entries.clear();
  }

  private async load(name: string, entry: Entry): Promise<void> {
    const started = this.deps.now();
    let decoded: Decoded | null = null;
    let failure = "";
    try {
      const bytes = await this.deps.read(entry.value);
      const table = pngGammaTable(bytes);
      const bitmap = await this.deps.decode(bytes);
      // gamma 校正（M9）：只带表，上传时 GPU 查表，位图保持直通 alpha
      decoded = {
        image: { width: bitmap.width, height: bitmap.height, source: bitmap, gamma: table },
        rects: new Map(),
        decodeMs: this.deps.now() - started,
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    // 后发先至：这一次已经被取代（值又变了，或来源表销毁），结果丢掉
    if (this.disposed || this.entries.get(name) !== entry) {
      if (decoded) closeImage(decoded.image);
      return;
    }
    if (!decoded) {
      entry.status = "failed";
      this.deps.log(`用户纹理 ${name}：读不出 ${entry.value}（${failure}），用缺省纹理`);
    } else {
      entry.status = "ready";
      entry.decoded = decoded;
      entry.decodeMs = decoded.decodeMs;
      this.remember(entry.value, decoded);
    }
    this.onReady?.(name);
  }

  /** 记进按值的缓存，超过上限时换出最旧的（正在被某个来源用着的不换）。 */
  private remember(value: string, decoded: Decoded): void {
    this.cache.set(value, decoded);
    const inUse = new Set<Decoded>();
    for (const entry of this.entries.values()) if (entry.decoded) inUse.add(entry.decoded);
    for (const [key, item] of this.cache) {
      if (this.cache.size <= DECODED_CACHE_SIZE) break;
      if (inUse.has(item)) continue;
      this.cache.delete(key);
      closeImage(item.image);
    }
  }

  // —— GIF 与视频（P11b 步骤 4）——

  /** 来源 `name` 的值是 GIF / 视频：认领这个值的 `Shared`（没有就建并开始加载），加载完成（或已完成）时记状态并通知。 */
  private attachMedia(name: string, entry: Entry, kind: "gif" | "video"): void {
    const shared = this.claim(entry.value, kind);
    entry.shared = shared;
    const finish = () => {
      if (this.disposed || this.entries.get(name) !== entry) return;
      if (shared.state === "failed") {
        entry.status = "failed";
        this.deps.log(`用户纹理 ${name}：读不出 ${entry.value}（${shared.error}），用缺省纹理`);
      } else {
        entry.status = "ready";
        entry.decodeMs = shared.loadMs;
      }
      this.onReady?.(name);
    };
    // 同一个值已经加载好的（别的来源在用）当场换上，同缓存命中
    if (shared.state !== "loading") {
      finish();
      return;
    }
    const task: Promise<void> = shared.ready.then(finish).finally(() => this.inflight.delete(task));
    this.inflight.add(task);
  }

  private claim(value: string, kind: "gif" | "video"): Shared {
    let shared = this.media.get(value);
    if (!shared) {
      shared = {
        kind,
        value,
        refs: 0,
        disposed: false,
        state: "loading",
        error: "",
        ready: Promise.resolve(),
        width: 0,
        height: 0,
        loadMs: 0,
        bytes: null,
        blob: null,
        initialGif: null,
        initialPlayer: null,
        textures: new Map(),
        rects: new Map(),
      };
      this.media.set(value, shared);
      shared.ready = this.loadShared(shared);
    }
    shared.refs++;
    return shared;
  }

  /** 放掉一份引用；最后一份放掉时释放（GIF 状态丢掉、播放器 `dispose`），之后再选回这个值是新的、从头开始。 */
  private releaseShared(shared: Shared): void {
    if (--shared.refs > 0) return;
    shared.disposed = true;
    if (this.media.get(shared.value) === shared) this.media.delete(shared.value);
    this.disposeShared(shared);
  }

  private disposeShared(shared: Shared): void {
    shared.initialPlayer?.dispose();
    for (const texture of shared.textures.values()) if (texture instanceof VideoTexture) texture.player.dispose();
    shared.initialPlayer = null;
    shared.initialGif = null;
    shared.bytes = null;
    shared.blob = null;
    shared.textures.clear();
    shared.rects.clear();
  }

  /** 读文件、打开 GIF / 建播放器等第一帧。出错一律记成 `failed`（槽用缺省纹理）；加载期间被放光引用的，结果丢掉。 */
  private async loadShared(shared: Shared): Promise<void> {
    const started = this.deps.now();
    try {
      if (shared.kind === "gif") {
        const bytes = await this.deps.read(shared.value);
        const gif = this.deps.openGif(bytes);
        if (shared.disposed) return;
        shared.bytes = bytes;
        shared.initialGif = gif;
        shared.width = gif.width;
        shared.height = gif.height;
      } else {
        const blob = await this.deps.readBlob(shared.value);
        if (shared.disposed) return;
        shared.blob = blob;
        const player = this.newPlayer(shared, blob);
        // 先登记再等：加载期间被放光引用时 `disposeShared` 能把它释放掉
        shared.initialPlayer = player;
        await withTimeout(player.firstFrame(), VIDEO_FIRST_FRAME_TIMEOUT_MS, "等视频第一帧超时");
        if (shared.disposed) return;
        const { videoWidth, videoHeight } = player.element;
        // 解码失败，或没有尺寸（rea-p11b 3.1 更正）：失败、用缺省纹理
        if (player.failed || !videoWidth || !videoHeight) throw new Error("视频解码失败或没有画面尺寸");
        shared.width = videoWidth;
        shared.height = videoHeight;
      }
      shared.state = "ready";
      shared.loadMs = this.deps.now() - started;
    } catch (error) {
      if (shared.disposed) return;
      shared.error = error instanceof Error ? error.message : String(error);
      shared.state = "failed";
      shared.initialPlayer?.dispose();
      shared.initialPlayer = null;
      shared.initialGif = null;
      shared.bytes = null;
      shared.blob = null;
    }
  }

  /** 同一个 Blob 的一个播放器（整个 Blob 就是区间）：建好立即按当前帧号与暂停状态开始。 */
  private newPlayer(shared: Shared, blob: Blob): VideoTexturePlayer {
    const player = new VideoTexturePlayer({ path: shared.value, start: 0, end: blob.size }, this.clock.frame, {
      ...this.deps.videoFactories,
      readBlob: () => Promise.resolve(blob),
      report: this.deps.report,
    });
    player.apply(this.clock.frame, this.clock.paused);
    return player;
  }

  /** 一个纹理名的帧状态：第一个请求的拿初始解出的，后来的各自再开一份（同一份字节 / Blob）。打不开时 null。 */
  private makeTexture(shared: Shared): MediaTexture | null {
    if (shared.kind === "gif") {
      let gif = shared.initialGif;
      shared.initialGif = null;
      if (!gif) {
        try {
          gif = this.deps.openGif(shared.bytes!);
        } catch (error) {
          this.deps.log(
            `用户纹理 ${shared.value}：再开一份 GIF 失败（${error instanceof Error ? error.message : error}）`,
          );
          return null;
        }
      }
      return new GifTexture(gif, this.clock);
    }
    let player = shared.initialPlayer;
    shared.initialPlayer = null;
    player ??= this.newPlayer(shared, shared.blob!);
    return new VideoTexture(player, this.clock);
  }

  /** 全部视频播放器（含还没被纹理名取走的初始播放器）。 */
  private *players(): Iterable<VideoTexturePlayer> {
    for (const shared of this.media.values()) if (shared.kind === "video") yield* this.sharedPlayers(shared);
  }

  private sharedPlayers(shared: Shared): VideoTexturePlayer[] {
    const list: VideoTexturePlayer[] = [];
    if (shared.initialPlayer) list.push(shared.initialPlayer);
    for (const texture of shared.textures.values()) if (texture instanceof VideoTexture) list.push(texture.player);
    return list;
  }

  /** seek 一个播放器到时刻 `time`（循环取模、钳到时长之内），等 `seeked`，超时也往下走。 */
  private seek(player: VideoTexturePlayer, time: number): Promise<void> {
    if (player.failed) return Promise.resolve();
    const element = player.element;
    const target = seekTarget(time, element.duration);
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.deps.log(`用户视频 ${player.source.path}：seek 到 ${target} s 超时`);
        finish();
      }, SEEK_TIMEOUT_MS);
      element.addEventListener("seeked", finish);
      player.currentTime = target;
    });
  }
}

function closeImage(image: UserTextureImage): void {
  const source = image.source as { close?: () => void };
  source.close?.();
}
