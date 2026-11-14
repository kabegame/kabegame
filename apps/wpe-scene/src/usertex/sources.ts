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
 * - **GIF 与视频**（`.gif`、`.mp4 .wmv .avi .m4v .mov .mkv .webm`，扩展名转小写再判断）：步骤 4 做，这里先当「无图」。
 */
import { cropRect, referenceRatio, textureKey, type CropRect } from "./crop";
import { pngGammaTable } from "./png";

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

/** 渲染器取到的一张裁好的用户图：WPE 的纹理名、解码后的整张源图、在源图上的矩形（纹理尺寸 = 矩形宽高）。 */
export interface UserTextureCrop {
  key: string;
  image: UserTextureImage;
  rect: CropRect;
}

/** 渲染器一侧的接口：`GpuScene` 只认它，单测与 dev 探针可以换自己的实现。 */
export interface UserTextureProvider {
  /**
   * 属性来源 `name` 当前值的裁切；没有图（值为空、读不出、还在解码、GIF / 视频）时 null。`reference` 是槽的参考尺寸（比例取它），
   * null 表示 `keepaspect`、整张进纹理。
   */
  crop(name: string, reference: { width: number; height: number } | null): UserTextureCrop | null;
}

export type UserTextureStatus = "none" | "loading" | "ready" | "empty" | "failed" | "unsupported";

/** 可注入的外部依赖（单测用假的）。 */
export interface UserTextureDeps {
  /** 读文件字节（参数是属性值，即绝对路径）；失败抛错。 */
  read(path: string): Promise<Uint8Array>;
  /** 把文件字节解成位图（`createImageBitmap` 带三个参数）。 */
  decode(bytes: Uint8Array): Promise<ImageBitmap>;
  now(): number;
  /** 一条 debug 日志。 */
  log(message: string): void;
}

/** dev 探针：一个来源的当前状态。 */
export interface UserTextureProbe {
  name: string;
  value: string;
  status: UserTextureStatus;
  width?: number;
  height?: number;
  /** 最近一次解码的用时（毫秒，含读文件）。 */
  decodeMs?: number;
  /** 已登记的纹理名（`crop` 请求过的），按登记顺序。 */
  keys: string[];
}

/** 解码结果按值缓存的张数上限（正在被来源用着的不算在内，不会被换出）。 */
export const DECODED_CACHE_SIZE = 4;

/** 视频的扩展名（小写）：步骤 4 实现，现在当「无图」。 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "wmv", "avi", "m4v", "mov", "mkv", "webm"]);

/** 路径的扩展名（小写，不含点）；没有时空串。 */
export function fileExtension(value: string): string {
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 这个值要走 GIF 或视频纹理（步骤 4），本步骤当「无图」。 */
export function isAnimatedMedia(value: string): boolean {
  const extension = fileExtension(value);
  return extension === "gif" || VIDEO_EXTENSIONS.has(extension);
}

interface Decoded {
  image: UserTextureImage;
  /** 纹理名 → 矩形：先请求的槽定比例。 */
  rects: Map<string, CropRect>;
  decodeMs: number;
}

interface Entry {
  value: string;
  status: UserTextureStatus;
  /** 当前值的解码结果（ready 时有）。 */
  decoded: Decoded | null;
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
  };
}

export class UserTextureSources implements UserTextureProvider {
  /**
   * 来源的图换好了（解码完成，或值清空 / 失败回到缺省）：宿主把渲染器那边标脏、暂停时补画一帧。同步调用（缓存命中时在 `setValue` 里就调）。
   */
  onReady: ((name: string) => void) | null = null;
  private readonly deps: UserTextureDeps;
  private readonly entries = new Map<string, Entry>();
  /** 值 → 解码结果（最近使用在后）。 */
  private readonly cache = new Map<string, Decoded>();
  private readonly inflight = new Set<Promise<void>>();
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
   * 设来源的值并开始异步解码。值没变什么都不做；变了：旧请求作废，空串、GIF / 视频当场记成无图，缓存命中当场换上，其余异步读文件解码。
   * 首次设空串也记一条（`status` 为 `empty`），不通知时机以外的差别。
   */
  setValue(name: string, value: string): void {
    if (this.disposed) return;
    const previous = this.entries.get(name);
    if (previous && previous.value === value) return;
    const entry: Entry = { value, status: "loading", decoded: null, seq: (previous?.seq ?? 0) + 1 };
    this.entries.set(name, entry);
    if (value === "") {
      entry.status = "empty";
      this.onReady?.(name);
      return;
    }
    if (isAnimatedMedia(value)) {
      // TODO(P11b 步骤 4)：GIF 走自己的解码器与按帧延时推进，视频走 P9a 的播放器；这里先当无图，槽用缺省纹理。
      entry.status = "unsupported";
      this.deps.log(`用户纹理 ${name}：${value} 是 GIF / 视频，步骤 4 才支持，先用缺省纹理`);
      this.onReady?.(name);
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
    const decoded = entry?.status === "ready" ? entry.decoded : null;
    if (!entry || !decoded) return null;
    const ratio = reference ? referenceRatio(reference.width, reference.height) : 0;
    const key = textureKey(entry.value, ratio);
    let rect = decoded.rects.get(key);
    if (!rect) {
      rect = cropRect(decoded.image.width, decoded.image.height, ratio);
      decoded.rects.set(key, rect);
    }
    return { key, image: decoded.image, rect };
  }

  probe(): UserTextureProbe[] {
    return [...this.entries].map(([name, entry]) => ({
      name,
      value: entry.value,
      status: entry.status,
      ...(entry.decoded ? { width: entry.decoded.image.width, height: entry.decoded.image.height } : {}),
      ...(entry.decodeMs !== undefined ? { decodeMs: Math.round(entry.decodeMs * 100) / 100 } : {}),
      keys: entry.decoded ? [...entry.decoded.rects.keys()] : [],
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.onReady = null;
    for (const decoded of this.cache.values()) closeImage(decoded.image);
    this.cache.clear();
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
}

function closeImage(image: UserTextureImage): void {
  const source = image.source as { close?: () => void };
  source.close?.();
}
