/**
 * .tex 容器布局移植自 linux-wallpaperengine（GPLv3，与本项目同许可）
 * `src/WallpaperEngine/Data/Parsers/TextureParser.cpp`。只按区间读头部与需要的 mip。
 */
import type { SceneFile } from "./fs";

export const TEX_FLAGS = {
  noInterpolation: 1,
  clampUVs: 2,
  animated: 4,
  clampBorder: 8,
  video: 32,
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
  videoRange?: { start: number; end: number };
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
  if (flags & TEX_FLAGS.animated) unsupported.push("tex:animation");
  if (format !== 0 && format !== 4) unsupported.push(`tex:format:${format}`);
  const freeImageMime = FREE_IMAGE_MIME[freeImageFormat];
  if (freeImageFormat !== -1 && !freeImageMime) unsupported.push(`tex:freeimage:${freeImageFormat}`);
  if (flags & TEX_FLAGS.clampBorder) unsupported.push("tex:clamp-border");
  if (flags & TEX_FLAGS.alphaPriority) unsupported.push("tex:alpha-priority");
  // FreeImage 的 mip 交给主线程解码，这里永远不读字节
  const shouldDecode = decode && unsupported.length === 0 && !freeImageMime;
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
    c.skip(frameCount * 32);
  }
  const first = images[0]?.mips[0];
  const videoRange =
    flags & TEX_FLAGS.video && first ? { start: first.offset, end: first.offset + first.length } : undefined;
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
    videoRange,
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
