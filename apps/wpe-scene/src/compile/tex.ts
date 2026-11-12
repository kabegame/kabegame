/**
 * .tex 容器布局移植自 linux-wallpaperengine（GPLv3，与本项目同许可）
 * `src/WallpaperEngine/Data/Parsers/TextureParser.cpp`。只按区间读头部与需要的 mip。
 *
 * 能按原格式上传的格式见 `TEXTURE_FORMATS`（编译期与渲染器共用），其余报 `tex:format:<n>`；FreeImage 形态（PNG / JPG）
 * 由主线程解码，只收格式 0。
 */
import type { SceneVideoSource } from "../video/player";
import type { SceneFile } from "./fs";

export const TEX_FLAGS = {
  noInterpolation: 1,
  clampUVs: 2,
  animated: 4,
  clampBorder: 8,
  video: 32,
  /**
   * alpha-priority（0x80000）：中性，不报。WPE 运行时没有任何分支读这一位，整个标志字只进采样器缓存的哈希键
   * （rea-p4b-render.md 1.3）；实测同一张 RG88 纹理去掉这一位，粒子和图像层 3 帧都是 0 个像素不同
   * （p4-particles-REPORT.md「P4b 语义的实测核对」）。只留作文档。
   */
  alphaPriority: 524288,
} as const;
export const TEX_FORMATS: Record<number, string> = {
  0: "rgba8888",
  1: "rgb888",
  2: "rgb565",
  4: "dxt5",
  6: "dxt3",
  7: "dxt1",
  8: "rg88",
  9: "r8",
  10: "rg1616f",
  11: "r16f",
  12: "bc7",
  13: "rgba1010102",
  14: "rgba16f",
  15: "rgb16f",
};

/** 一种按原格式上传的 `.tex` 格式：WebGPU 格式与 mip 的块布局。 */
export interface TextureFormatInfo {
  gpu: GPUTextureFormat;
  /** 压缩块边长（非压缩为 1）。 */
  block: number;
  /** 每块（非压缩为每像素）字节数。 */
  bytesPerBlock: number;
  /** 需要的设备特性。 */
  feature?: GPUFeatureName;
}

/**
 * 按原格式整块上传的 `.tex` 格式（非 FreeImage 形态），是格式支持范围的唯一来源：编译期（Worker）据此判 `tex:format:<n>`，
 * 渲染器（`render/textures.ts`）据此建纹理、算 mip 的上传布局、要设备特性。这里只放格式名和数字，不依赖 GPU 运行时对象。
 *
 * DXGI 格式照 WPE 的映射函数 `FUN_1400d2a20`（rea-p4b-render.md 1.2）：都不是 sRGB，上传前不改通道。单、双通道纹理采样时
 * 缺的通道补 0、alpha 补 1，D3D 与 WebGPU 相同，所以图像层直接拿原始采样值（实测 R8 显示成 `(r, 0, 0, 1)` 的红色）；
 * 通道换算只在定义了 `TEX<n>FORMAT` 时由着色器的 `ConvertTexture<n>Format` 做。mip 数据紧排、没有行填充（本机语料逐 mip 核对过）。
 */
export const TEXTURE_FORMATS: Readonly<Record<number, TextureFormatInfo>> = {
  /** RGBA8888 → `R8G8B8A8_UNORM`。 */
  0: { gpu: "rgba8unorm", block: 1, bytesPerBlock: 4 },
  /** DXT5 → `BC3_UNORM`。 */
  4: { gpu: "bc3-rgba-unorm", block: 4, bytesPerBlock: 16, feature: "texture-compression-bc" },
  /** DXT3 → `BC2_UNORM`。 */
  6: { gpu: "bc2-rgba-unorm", block: 4, bytesPerBlock: 16, feature: "texture-compression-bc" },
  /** DXT1 → `BC1_UNORM`。 */
  7: { gpu: "bc1-rgba-unorm", block: 4, bytesPerBlock: 8, feature: "texture-compression-bc" },
  /** RG88 → `R8G8_UNORM`，采样得 `(r, g, 0, 1)`。 */
  8: { gpu: "rg8unorm", block: 1, bytesPerBlock: 2 },
  /** R8 → `R8_UNORM`，采样得 `(r, 0, 0, 1)`。 */
  9: { gpu: "r8unorm", block: 1, bytesPerBlock: 1 },
};

/** 格式表里的一项；不在表里返回 undefined（不走原型链）。 */
export function textureFormat(format: number): TextureFormatInfo | undefined {
  return Object.hasOwn(TEXTURE_FORMATS, format) ? TEXTURE_FORMATS[format] : undefined;
}

/**
 * effect fbo 的格式名（effect.json `fbos[].format`，B6）→ `.tex` 格式枚举（翻译器的 `TEX<n>FORMAT`）与 WebGPU 格式。
 * `rgb888` / `rgb161616f` 在 DXGI 里也是四通道。
 */
export const FBO_FORMATS: Record<string, { tex: number; gpu: string }> = {
  rgba8888: { tex: 0, gpu: "rgba8unorm" },
  rgb888: { tex: 1, gpu: "rgba8unorm" },
  rg88: { tex: 8, gpu: "rg8unorm" },
  r8: { tex: 9, gpu: "r8unorm" },
  rg1616f: { tex: 10, gpu: "rg16float" },
  r16f: { tex: 11, gpu: "r16float" },
  rgba16161616f: { tex: 14, gpu: "rgba16float" },
  rgb161616f: { tex: 15, gpu: "rgba16float" },
};
export interface TexMip {
  width: number;
  height: number;
  compression: number;
  offset: number;
  length: number;
  uncompressedSize: number;
  bytes?: Uint8Array;
}
export interface TexImage {
  mips: TexMip[];
}
/**
 * TEXS 帧表的一帧（`FUN_14015e1d0`，rea-p4b-render.md 2.1）。文件里每帧 32 字节：`imageId`（i32）、`frametime`（f32）、
 * 6 个坐标（TEXS0001 是 i32，0002 / 0003 是 f32）。坐标已按该帧所在图像的第 0 级 mip 尺寸 `(W, H)` 归一化：
 * `x / W, y / H, width / W, widthY / H, heightX / W, height / H`，float32 精确除法（`divss`）。`imageId` 越界或该图像
 * 没有 mip 时 6 个坐标为 0。粒子路径只读第 0 帧的 `width`、`height`（见 `bundle.ts` 的 `spriteSheet`）。
 */
export interface TexFrame {
  image: number;
  frametime: number;
  x: number;
  y: number;
  width: number;
  widthY: number;
  heightX: number;
  height: number;
}
export interface TexResult {
  format: number;
  flags: number;
  width: number;
  height: number;
  textureWidth: number;
  textureHeight: number;
  containerVersion: number;
  freeImageFormat: number;
  images: TexImage[];
  animatedVersion?: number;
  frameCount?: number;
  gifWidth?: number;
  gifHeight?: number;
  /** 头标志 bit2（`animated`）置位时的帧表，按文件顺序（`TexFrame`）。 */
  frames?: TexFrame[];
  /**
   * 视频纹理（头标志 `video`，P9a）：第 0 张图像第 0 级 mip（就是整段 MP4）在磁盘上的绝对区间，写法同 `encoded`（`SceneFile.location`
   * 加 mip 偏移，散文件偏移 0、pkg 条目带条目偏移）。Worker 一个字节都不读，由主线程的播放器（`video/player.ts`）按区间读。
   */
  video?: SceneVideoSource;
  /**
   * FreeImage 形态（`freeImageFormat` 为 2 JPEG / 13 PNG）：每个 mip 的数据是一整份图片文件。Worker 不读这些字节，
   * 只给出它们在磁盘上的位置（`SceneFile.location`），由主线程区间读、`createImageBitmap` 解码并跨重新编译缓存。
   */
  encoded?: { mime: "image/png" | "image/jpeg"; path: string; mips: { start: number; end: number }[] };
  unsupported: string[];
}

/** FreeImage 格式枚举（FIF_*）→ MIME；只认浏览器能解码的两种。 */
const FREE_IMAGE_MIME: Record<number, "image/png" | "image/jpeg"> = { 2: "image/jpeg", 13: "image/png" };

class Cursor {
  pos = 0;
  private window: Uint8Array<ArrayBufferLike>;
  private windowStart = 0;
  constructor(private file: SceneFile) {
    this.window = file.head ?? new Uint8Array();
  }
  async bytes(n: number): Promise<Uint8Array> {
    if (n < 0 || (this.file.size !== null && this.pos + n > this.file.size)) throw new Error("纹理头或 mip 被截断");
    if (n === 0) return new Uint8Array();
    if (n > 4096) {
      const at = this.pos;
      this.pos += n;
      const bytes = await this.file.readRange(at, this.pos);
      if (bytes.length !== n) throw new Error("纹理读取被截断");
      return bytes;
    }
    if (this.pos < this.windowStart || this.pos + n > this.windowStart + this.window.length) {
      this.windowStart = this.pos;
      this.window = await this.file.readRange(
        this.pos,
        this.file.size === null ? this.pos + Math.max(4096, n) : Math.min(this.file.size, this.pos + Math.max(4096, n)),
      );
    }
    if (this.pos + n > this.windowStart + this.window.length) throw new Error("纹理读取被截断");
    const result = this.window.slice(this.pos - this.windowStart, this.pos - this.windowStart + n);
    this.pos += n;
    return result;
  }
  async u32(): Promise<number> {
    const b = await this.bytes(4);
    return new DataView(b.buffer).getUint32(0, true);
  }
  async i32(): Promise<number> {
    const b = await this.bytes(4);
    return new DataView(b.buffer).getInt32(0, true);
  }
  async magic(): Promise<string> {
    return new TextDecoder().decode(await this.bytes(9)).replace(/\0$/, "");
  }
  async zstr(): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const b = (await this.bytes(1))[0];
      if (b === 0) return new TextDecoder().decode(new Uint8Array(bytes));
      bytes.push(b);
      if (bytes.length > 1024 * 1024) throw new Error("纹理 JSON 过长");
    }
  }
  skip(n: number): void {
    if (n < 0 || (this.file.size !== null && this.pos + n > this.file.size)) throw new Error("纹理数据越界");
    this.pos += n;
  }
}

/** LZ4 block；严格校验输入和输出长度。 */
export function decodeLz4Block(input: Uint8Array, outputSize: number): Uint8Array {
  const output = new Uint8Array(outputSize);
  let src = 0,
    dst = 0;
  while (src < input.length) {
    const token = input[src++];
    let literals = token >> 4;
    if (literals === 15) {
      let n: number;
      do {
        if (src >= input.length) throw new Error("LZ4 截断");
        n = input[src++];
        literals += n;
      } while (n === 255);
    }
    if (src + literals > input.length || dst + literals > output.length) throw new Error("LZ4 字面量越界");
    output.set(input.subarray(src, src + literals), dst);
    src += literals;
    dst += literals;
    if (src === input.length) break;
    if (src + 2 > input.length) throw new Error("LZ4 偏移截断");
    const offset = input[src] | (input[src + 1] << 8);
    src += 2;
    if (!offset || offset > dst) throw new Error("LZ4 偏移越界");
    let match = (token & 15) + 4;
    if ((token & 15) === 15) {
      let n: number;
      do {
        if (src >= input.length) throw new Error("LZ4 长度截断");
        n = input[src++];
        match += n;
      } while (n === 255);
    }
    if (dst + match > output.length) throw new Error("LZ4 输出越界");
    for (let i = 0; i < match; i++) output[dst + i] = output[dst + i - offset];
    dst += match;
  }
  if (dst !== outputSize) throw new Error(`LZ4 输出长度 ${dst} != ${outputSize}`);
  return output;
}

/** 帧表纹理的不支持项：用在粒子材质槽 0 以外的地方时报（`bundle.ts` 的 `getTexture` 按用途过滤）。 */
export const ANIMATION_ISSUE = "tex:animation";

/**
 * TEXS 的帧（`FUN_14015e1d0`，rea-p4b-render.md 2.1）：每帧 32 字节，`imageId` 按有符号读（`movsxd`），TEXS0001 的 6 个坐标
 * 是 i32（`cvtdq2ps` 转 float），0002 / 0003 是 f32。归一化的分母是 `imageId` 号图像第 0 级 mip 的宽高（`cvtsi2ss`），
 * float32 精确除法；越界或该图像没有 mip 时 6 个坐标写 0。
 */
function readFrames(bytes: Uint8Array, version: number, images: readonly TexImage[]): TexFrame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: TexFrame[] = [];
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    const image = view.getInt32(at, true);
    const coord = (k: number) =>
      version === 1 ? Math.fround(view.getInt32(at + 8 + 4 * k, true)) : view.getFloat32(at + 8 + 4 * k, true);
    const mip = image >= 0 && image < images.length ? images[image].mips[0] : undefined;
    const [x, y, width, widthY, heightX, height] = [0, 1, 2, 3, 4, 5].map((k) =>
      mip ? Math.fround(coord(k) / Math.fround(k % 2 === 0 ? mip.width : mip.height)) : 0,
    );
    frames.push({ image, frametime: view.getFloat32(at + 4, true), x, y, width, widthY, heightX, height });
  }
  return frames;
}

export async function parseTex(file: SceneFile, decode = true): Promise<TexResult> {
  const c = new Cursor(file);
  if ((await c.magic()) !== "TEXV0005" || (await c.magic()) !== "TEXI0001") throw new Error("不支持的 TEX 头");
  const format = await c.u32(),
    flags = await c.u32();
  const textureWidth = await c.u32(),
    textureHeight = await c.u32(),
    width = await c.u32(),
    height = await c.u32();
  await c.u32();
  const container = await c.magic();
  if (!/^TEXB000[1-4]$/.test(container)) throw new Error(`不支持的 TEX 容器：${container}`);
  const containerVersion = Number(container.at(-1)),
    imageCount = await c.u32();
  if (imageCount > 10000) throw new Error("纹理图像数异常");
  let freeImageFormat = -1,
    videoMp4 = 0;
  if (containerVersion >= 3) freeImageFormat = await c.i32();
  if (containerVersion === 4) videoMp4 = await c.u32();
  const mipLayoutVersion = containerVersion === 4 && videoMp4 === 1 ? 4 : Math.min(containerVersion, 3);
  const unsupported: string[] = [];
  if (flags & TEX_FLAGS.video) unsupported.push("tex:video");
  // 帧表纹理：粒子材质的槽 0 是合法用法（P4b 步骤 2），`bundle.ts` 的 `getTexture` 按用途去掉这个键；图像层的帧动画属 P6，照报
  if (flags & TEX_FLAGS.animated) unsupported.push(ANIMATION_ISSUE);
  // 粒子路径只采第 0 张图像（rea-p4b-render.md 2.7【推】），帧落在别的图像上会采错
  if (flags & TEX_FLAGS.animated && imageCount > 1) unsupported.push("tex:animation:multi-image");
  const freeImageMime = FREE_IMAGE_MIME[freeImageFormat];
  // 原格式上传查格式表；FreeImage 形态由主线程解成 RGBA 位图（`planBitmapUpload` 只收格式 0，本机语料也都是 0）
  if (freeImageMime ? format !== 0 : !textureFormat(format)) unsupported.push(`tex:format:${format}`);
  if (freeImageFormat !== -1 && !freeImageMime) unsupported.push(`tex:freeimage:${freeImageFormat}`);
  if (flags & TEX_FLAGS.clampBorder) unsupported.push("tex:clamp-border");
  // FreeImage 的 mip 交给主线程解码，这里永远不读字节。`tex:animation` 不挡解码：帧表纹理在粒子槽 0 要上传；用在图像层时
  // 场景反正退回，多解一张纹理只在 `exhaustive` / `force` 下发生。`tex:animation:empty` 在 mip 之后才读到，同样不挡
  // 视频的 mip 就是整段视频（语料最大 674 MiB）：显式按 Video 标志跳过，不靠 `tex:video` 挡（步骤 3 删掉这个键之后它就挡不住了），
  // 否则 Worker 会经主线程代读整段视频。只给区间，由主线程的播放器读（P9a）
  const shouldDecode =
    decode && !(flags & TEX_FLAGS.video) && unsupported.every((key) => key === ANIMATION_ISSUE) && !freeImageMime;
  const images: TexImage[] = [];
  for (let image = 0; image < imageCount; image++) {
    const mipCount = await c.u32();
    if (mipCount > 64) throw new Error("mip 数异常");
    const mips: TexMip[] = [];
    for (let i = 0; i < mipCount; i++) {
      if (mipLayoutVersion === 4) {
        await c.u32();
        await c.u32();
        await c.zstr();
        await c.u32();
      }
      const mipWidth = await c.u32(),
        mipHeight = await c.u32();
      const compression = mipLayoutVersion >= 2 ? await c.u32() : 0;
      const uncompressedSize = mipLayoutVersion >= 2 ? await c.i32() : 0;
      const length = await c.i32();
      if (length < 0 || uncompressedSize < 0) throw new Error("mip 长度异常");
      const offset = c.pos;
      const mip: TexMip = {
        width: mipWidth,
        height: mipHeight,
        compression,
        offset,
        length,
        uncompressedSize: compression ? uncompressedSize : length,
      };
      if (compression > 1) unsupported.push(`tex:compression:${compression}`);
      // LZ4 包着的图片文件没见过；主线程按原样解码，遇到先报
      if (freeImageMime && compression === 1) unsupported.push("tex:freeimage-lz4");
      if (shouldDecode && compression <= 1) {
        const bytes = await c.bytes(length);
        mip.bytes = compression === 1 ? decodeLz4Block(bytes, uncompressedSize) : bytes;
      } else c.skip(length);
      mips.push(mip);
    }
    images.push({ mips });
  }
  let animatedVersion: number | undefined;
  let frameCount: number | undefined;
  let gifWidth: number | undefined;
  let gifHeight: number | undefined;
  let frames: TexFrame[] | undefined;
  if (flags & TEX_FLAGS.animated) {
    const magic = await c.magic();
    if (!/^TEXS000[1-3]$/.test(magic)) throw new Error(`不支持的 TEXS 帧表：${magic}`);
    animatedVersion = Number(magic.at(-1));
    frameCount = await c.u32();
    if (frameCount > 100000) throw new Error("动画帧数异常");
    if (animatedVersion === 3) {
      gifWidth = await c.u32();
      gifHeight = await c.u32();
    }
    frames = readFrames(await c.bytes(frameCount * 32), animatedVersion, images);
    // 帧向量为空时 WPE 不写 `g_RenderVar1`、保留上一次绘制的值（rea-p4b-render.md 2.2），不复刻
    if (frameCount === 0) unsupported.push("tex:animation:empty");
  }
  const first = images[0]?.mips[0];
  const video =
    flags & TEX_FLAGS.video && first
      ? {
          path: file.location.path,
          start: file.location.offset + first.offset,
          end: file.location.offset + first.offset + first.length,
        }
      : undefined;
  const encoded =
    freeImageMime && !(flags & TEX_FLAGS.video) && images[0]
      ? {
          mime: freeImageMime,
          path: file.location.path,
          mips: images[0].mips.map((mip) => ({
            start: file.location.offset + mip.offset,
            end: file.location.offset + mip.offset + mip.length,
          })),
        }
      : undefined;
  return {
    format,
    flags,
    width,
    height,
    textureWidth,
    textureHeight,
    containerVersion,
    freeImageFormat,
    images,
    animatedVersion,
    frameCount,
    gifWidth,
    gifHeight,
    frames,
    video,
    encoded,
    unsupported,
  };
}

/**
 * FreeImage 形态的「纹理尺寸」（`g_Texture<n>Resolution.xy`、UV 上界的分母，渲染器也按它建 GPU 纹理）：WPE 解码前把头里的
 * 纹理尺寸强制改成头里的图像尺寸（`FUN_14015c8d0`），所以 UV 缩放为 1。razer_vortex 的头写 4096×4096、图像 3840×2160，
 * 两组尺寸都是 3840×2160；两组都取头字段、不取解码结果。渲染器把解码结果拷到这个尺寸纹理的左上角。
 */
export function freeImageTextureSize(tex: Pick<TexResult, "width" | "height">): [number, number] {
  return [tex.width, tex.height];
}
