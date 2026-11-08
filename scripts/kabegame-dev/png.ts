/**
 * PNG 解码、编码与缩小，只用 `node:zlib`，不依赖页面。REST（`resize`）与 MCP（内联图片缩小）共用。
 *
 * 只支持 CEF 截图与场景探针输出的那几种：8 位、不隔行的 RGB（颜色类型 2）与 RGBA（颜色类型 6）。调色板、灰度、
 * 16 位、Adam7 隔行一律抛 `PngError`，不做近似，免得静默回一张错图。CRC 与解压后的长度都校验。
 */
import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngError";
  }
}

/** 解码后的像素：行优先、无行间填充，`channels` 为 3（RGB）或 4（RGBA，直通 alpha）。 */
export interface RawImage {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array;
}

export interface ImageDims {
  width: number;
  height: number;
}

/** 回到会话里的尺寸约束：等比、不放大，几项同时给时取最严的。 */
export interface ResizeSpec {
  /** 相对原尺寸的倍数，大于 1 按 1 算。 */
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** 不给尺寸约束时：长边缩到这么长（Claude 读图的建议上限）。 */
export const DEFAULT_MAX_EDGE = 1568;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const COLOR_TYPES: Record<number, string> = {
  0: "灰度",
  2: "RGB",
  3: "调色板",
  4: "灰度 + alpha",
  6: "RGBA",
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0xffffffff): number {
  let c = seed;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

const crcOf = (type: Uint8Array, data: Uint8Array) => (crc32(data, 0, data.length, crc32(type)) ^ 0xffffffff) >>> 0;

/** PNG 头里的宽高（IHDR），不是 PNG 时为 null。不解码。 */
export function pngSize(png: Uint8Array): ImageDims | null {
  if (png.length < 24 || !SIGNATURE.every((byte, i) => png[i] === byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** 解码 8 位、不隔行的 RGB / RGBA PNG；别的格式抛 `PngError`。 */
export function decodePng(png: Uint8Array): RawImage {
  if (png.length < 8 || !SIGNATURE.every((byte, i) => png[i] === byte)) throw new PngError("不是 PNG（签名不对）");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new PngError("PNG 截断（块头不完整）");
    const length = view.getUint32(offset);
    const typeBytes = png.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) throw new PngError(`PNG 截断（${type} 块不完整）`);
    const data = png.subarray(dataStart, dataEnd);
    if (crcOf(typeBytes, data) !== view.getUint32(dataEnd)) throw new PngError(`PNG 损坏（${type} 块 CRC 不对）`);
    offset = dataEnd + 4;
    if (type === "IHDR") {
      if (length !== 13) throw new PngError("IHDR 长度不对");
      header = {
        width: view.getUint32(dataStart),
        height: view.getUint32(dataStart + 4),
        depth: png[dataStart + 8],
        color: png[dataStart + 9],
        interlace: png[dataStart + 12],
      };
      if (png[dataStart + 10] !== 0 || png[dataStart + 11] !== 0) throw new PngError("不支持的压缩或过滤方法");
    } else if (!header) {
      throw new PngError("PNG 的第一个块不是 IHDR");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      ended = true;
      break;
    } else if (type !== "PLTE" && (typeBytes[0] & 0x20) === 0) {
      // 辅助块（首字母小写）与 PLTE 都忽略：RGB / RGBA 里的 PLTE 只是建议调色板，调色板图下面按颜色类型拒绝
      throw new PngError(`不认识的关键块 ${type}`);
    }
  }
  if (!header) throw new PngError("PNG 没有 IHDR");
  if (!ended) throw new PngError("PNG 截断（没有 IEND）");
  const { width, height, depth, color, interlace } = header;
  if (color !== 2 && color !== 6) {
    throw new PngError(`不支持的 PNG 颜色类型 ${color}（${COLOR_TYPES[color] ?? "未知"}）：只支持 8 位 RGB / RGBA`);
  }
  if (depth !== 8) throw new PngError(`不支持 ${depth} 位 PNG：只支持 8 位 RGB / RGBA`);
  if (interlace !== 0) throw new PngError("不支持隔行（Adam7）PNG：只支持不隔行的 8 位 RGB / RGBA");
  if (width === 0 || height === 0) throw new PngError("PNG 宽或高为 0");
  if (!idat.length) throw new PngError("PNG 没有 IDAT");

  const channels = color === 6 ? 4 : 3;
  const stride = width * channels;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new PngError(`PNG 像素数据解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.length < height * (stride + 1)) {
    throw new PngError(`PNG 像素数据不够：要 ${height * (stride + 1)} 字节，只有 ${raw.length}`);
  }
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    switch (filter) {
      case 0:
        out.set(raw.subarray(src, src + stride), dst);
        break;
      case 1:
        for (let i = 0; i < stride; i++) {
          out[dst + i] = (raw[src + i] + (i >= channels ? out[dst + i - channels] : 0)) & 0xff;
        }
        break;
      case 2:
        for (let i = 0; i < stride; i++) out[dst + i] = (raw[src + i] + (y > 0 ? out[up + i] : 0)) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? out[dst + i - channels] : 0;
          const b = y > 0 ? out[up + i] : 0;
          out[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? out[dst + i - channels] : 0;
          const b = y > 0 ? out[up + i] : 0;
          const c = i >= channels && y > 0 ? out[up + i - channels] : 0;
          out[dst + i] = (raw[src + i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new PngError(`PNG 第 ${y} 行的过滤类型 ${filter} 不合法`);
    }
  }
  return { width, height, channels, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  const typeBytes = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crcOf(typeBytes, data));
  return out;
}

/**
 * 编码成 8 位 RGB / RGBA PNG。每行按「绝对值和最小」挑过滤类型（libpng 的常用启发式），压缩级别 6。
 */
export function encodePng(image: RawImage): Uint8Array {
  const { width, height, channels, data } = image;
  if (channels !== 3 && channels !== 4) throw new PngError(`只能编码 3 或 4 通道，收到 ${channels}`);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new PngError(`尺寸不合法：${width}×${height}`);
  }
  const stride = width * channels;
  if (data.length !== height * stride)
    throw new PngError(`像素长度 ${data.length} 与 ${width}×${height}×${channels} 不符`);
  const filtered = new Uint8Array(height * (stride + 1));
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const up = row - stride;
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const x = data[row + i];
        const a = i >= channels ? data[row + i - channels] : 0;
        const b = y > 0 ? data[up + i] : 0;
        const c = i >= channels && y > 0 ? data[up + i - channels] : 0;
        const predictor =
          filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const value = (x - predictor) & 0xff;
        score += value < 128 ? value : 256 - value;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    const dst = y * (stride + 1);
    filtered[dst] = best;
    for (let i = 0; i < stride; i++) {
      const x = data[row + i];
      const a = i >= channels ? data[row + i - channels] : 0;
      const b = y > 0 ? data[up + i] : 0;
      const c = i >= channels && y > 0 ? data[up + i - channels] : 0;
      const predictor = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      candidate[i] = (x - predictor) & 0xff;
    }
    filtered.set(candidate, dst + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const idat = new Uint8Array(deflateSync(filtered, { level: 6 }));
  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 每个输出下标覆盖的源区间 `[i·r, (i+1)·r)`，r = src / dst：起点与各源下标的权重（和为 1）。 */
function axisWeights(src: number, dst: number): Array<{ start: number; weights: Float64Array }> {
  const ratio = src / dst;
  const out = [];
  for (let i = 0; i < dst; i++) {
    const from = i * ratio;
    const to = Math.min(src, (i + 1) * ratio);
    const start = Math.floor(from);
    const end = Math.min(src, Math.ceil(to - 1e-9));
    const weights = new Float64Array(Math.max(1, end - start));
    for (let j = start; j < start + weights.length; j++) {
      weights[j - start] = (Math.min(j + 1, to) - Math.max(j, from)) / ratio;
    }
    out.push({ start, weights });
  }
  return out;
}

/**
 * 按面积平均缩小（每个输出像素是它覆盖的源区域的加权平均，边缘按覆盖比例算）。RGBA 先乘 alpha 再平均，
 * 透明像素的颜色不会渗进来；不透明图与直接平均相同。只缩小：目标比原图大时抛错。
 */
export function downscale(image: RawImage, width: number, height: number): RawImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PngError(`目标尺寸不合法：${width}×${height}`);
  }
  if (width > image.width || height > image.height) {
    throw new PngError(`只缩小不放大：${image.width}×${image.height} → ${width}×${height}`);
  }
  if (width === image.width && height === image.height) return image;
  const { channels, data } = image;
  const srcStride = image.width * channels;
  const xs = axisWeights(image.width, width);
  const ys = axisWeights(image.height, height);
  const alpha = channels === 4;
  // 先纵向把覆盖到的源行加权累加成一行（RGBA 时颜色已乘 alpha），再横向归并
  const row = new Float64Array(image.width * 4);
  const out = new Uint8Array(width * height * channels);
  for (let dy = 0; dy < height; dy++) {
    row.fill(0);
    const { start: sy0, weights: wy } = ys[dy];
    for (let k = 0; k < wy.length; k++) {
      const w = wy[k];
      if (w === 0) continue;
      const base = (sy0 + k) * srcStride;
      for (let sx = 0; sx < image.width; sx++) {
        const p = base + sx * channels;
        const q = sx * 4;
        if (alpha) {
          const aw = data[p + 3] * w;
          row[q] += data[p] * aw;
          row[q + 1] += data[p + 1] * aw;
          row[q + 2] += data[p + 2] * aw;
          row[q + 3] += aw;
        } else {
          row[q] += data[p] * w;
          row[q + 1] += data[p + 1] * w;
          row[q + 2] += data[p + 2] * w;
        }
      }
    }
    for (let dx = 0; dx < width; dx++) {
      const { start: sx0, weights: wx } = xs[dx];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < wx.length; k++) {
        const w = wx[k];
        const q = (sx0 + k) * 4;
        r += row[q] * w;
        g += row[q + 1] * w;
        b += row[q + 2] * w;
        a += row[q + 3] * w;
      }
      const o = (dy * width + dx) * channels;
      if (alpha) {
        out[o + 3] = clamp(a);
        if (a > 0) {
          out[o] = clamp(r / a);
          out[o + 1] = clamp(g / a);
          out[o + 2] = clamp(b / a);
        }
      } else {
        out[o] = clamp(r);
        out[o + 1] = clamp(g);
        out[o + 2] = clamp(b);
      }
    }
  }
  return { width, height, channels, data: out };
}

const clamp = (value: number) => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value));

/** 校验尺寸约束；不合法抛 `PngError`。`undefined` 原样回。 */
export function parseResizeSpec(value: unknown): ResizeSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new PngError("尺寸约束要是 { scale?, maxWidth?, maxHeight? }");
  const spec = value as Record<string, unknown>;
  const unknownKeys = Object.keys(spec).filter((key) => !["scale", "maxWidth", "maxHeight"].includes(key));
  if (unknownKeys.length)
    throw new PngError(`尺寸约束不认识 ${unknownKeys.join("、")}（只有 scale / maxWidth / maxHeight）`);
  const out: ResizeSpec = {};
  if (spec.scale !== undefined) {
    if (typeof spec.scale !== "number" || !Number.isFinite(spec.scale) || spec.scale <= 0) {
      throw new PngError("scale 要是正数");
    }
    out.scale = spec.scale;
  }
  for (const key of ["maxWidth", "maxHeight"] as const) {
    const n = spec[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new PngError(`${key} 要是正整数（像素）`);
    out[key] = n;
  }
  return out;
}

/**
 * 按约束算回传尺寸：等比、不放大，几项同时给时取最严的。`spec` 缺省或一项都没给时按长边 `DEFAULT_MAX_EDGE`。
 */
export function fitSize(original: ImageDims, spec?: ResizeSpec): ImageDims {
  const { width, height } = original;
  const given = spec && (spec.scale !== undefined || spec.maxWidth !== undefined || spec.maxHeight !== undefined);
  let factor = 1;
  if (!given) {
    factor = Math.min(1, DEFAULT_MAX_EDGE / Math.max(width, height));
  } else {
    if (spec!.scale !== undefined) factor = Math.min(factor, spec!.scale);
    if (spec!.maxWidth !== undefined) factor = Math.min(factor, spec!.maxWidth / width);
    if (spec!.maxHeight !== undefined) factor = Math.min(factor, spec!.maxHeight / height);
  }
  if (factor >= 1) return { width, height };
  // 四舍五入单调，受约束的那条边正好落在上限上，另一条边不会超过自己的上限
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
}

export interface ResizedPng {
  png: Uint8Array;
  original: ImageDims;
  returned: ImageDims;
  resized: boolean;
}

/**
 * 按约束缩小 PNG（规则同 `fitSize`）。不需要缩小时原样回字节、不解码；需要缩小而格式不支持时抛 `PngError`。
 */
export function resizePng(png: Uint8Array, spec?: ResizeSpec): ResizedPng {
  const original = pngSize(png);
  if (!original) throw new PngError("不是 PNG（签名不对）");
  const returned = fitSize(original, spec);
  if (returned.width === original.width && returned.height === original.height) {
    return { png, original, returned, resized: false };
  }
  const image = decodePng(png);
  return { png: encodePng(downscale(image, returned.width, returned.height)), original, returned, resized: true };
}
