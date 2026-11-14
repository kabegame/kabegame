/**
 * `gif.test.ts` 用的最小 GIF 编码器：LZW 码流按「解码器视角」的码宽规则打包，
 * 可以明确构造清除码、结束码、码宽增长、KwKwK 与各种非法码流；块拼装函数都是裸字节，方便造出各种非标准文件。
 */

export type Rgb = readonly [number, number, number];

export function concat(...parts: (number[] | Uint8Array)[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];

/** 把码流打成字节：码宽按解码器的规则推进（avail 每个非清除码 +1，首个码后不 +1，到 2 的幂就加宽，上限 12）。 */
export function packCodes(codes: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes: number[] = [];
  let acc = 0;
  let nacc = 0;
  let width = minCodeSize + 1;
  let avail = eoi + 1;
  let afterClear = true;
  for (const code of codes) {
    acc |= code << nacc;
    nacc += width;
    while (nacc >= 8) {
      bytes.push(acc & 255);
      acc >>>= 8;
      nacc -= 8;
    }
    if (code === clear) {
      width = minCodeSize + 1;
      avail = eoi + 1;
      afterClear = true;
    } else if (code !== eoi) {
      if (!afterClear) avail++;
      afterClear = false;
      if ((avail & ((1 << width) - 1)) === 0 && avail < 0x1000) width++;
    }
  }
  if (nacc > 0) bytes.push(acc & 255);
  return bytes;
}

/** 标准 LZW 编码成码列表（清除码开头、结束码收尾；字典满时发清除码）。`skipClear` 不发开头的清除码。 */
export function lzwCodes(indices: ArrayLike<number>, minCodeSize: number, skipClear = false): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const codes: number[] = [];
  if (!skipClear) codes.push(clear);
  // 字典：key = prefix * 256 + k，值 = generation * 4096 + code；换代代替清空。
  const dict = new Int32Array(4096 * 256);
  let gen = 1;
  let next = eoi + 1;
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const v = dict[prefix * 256 + k]!;
    if (v >>> 12 === gen) {
      prefix = v & 4095;
      continue;
    }
    codes.push(prefix);
    if (next < 4096) {
      dict[prefix * 256 + k] = gen * 4096 + next++;
    } else {
      codes.push(clear);
      gen++;
      next = eoi + 1;
    }
    prefix = k;
  }
  codes.push(prefix, eoi);
  return codes;
}

/** 把字节切成 ≤ 255 的子块并以 0 结尾。 */
export function subblocks(bytes: number[], blockSize = 255): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += blockSize) {
    const chunk = bytes.slice(i, i + blockSize);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

export interface Gce {
  /** disposal 方法 0–7。 */
  disposal?: number;
  /** 透明下标；不给 = 不带透明位。 */
  transparent?: number;
  /** 延时（百分之一秒）。 */
  delay?: number;
}

/** 图形控制扩展（长度 4）。 */
export function gceBlock(g: Gce): number[] {
  const flags = ((g.disposal ?? 0) << 2) | (g.transparent !== undefined ? 1 : 0);
  return [0x21, 0xf9, 4, flags, ...u16(g.delay ?? 0), g.transparent ?? 0, 0];
}

/** 调色板字节（项数补到 2 的幂、至少 2）。返回 [字节, 大小字段]。 */
export function paletteBytes(palette: readonly Rgb[]): [number[], number] {
  let n = 2;
  let field = 0;
  while (n < palette.length) {
    n <<= 1;
    field++;
  }
  const bytes: number[] = [];
  for (let i = 0; i < n; i++) bytes.push(...(palette[i] ?? [0, 0, 0]));
  return [bytes, field];
}

/** 文件头 + 逻辑屏幕描述符 + 可选全局调色板。 */
export function headerBlock(
  width: number,
  height: number,
  opts: { palette?: readonly Rgb[]; bgindex?: number; version?: "87a" | "89a" | string } = {},
): number[] {
  const out = [...[...("GIF" + (opts.version ?? "89a"))].map((c) => c.charCodeAt(0)), ...u16(width), ...u16(height)];
  if (opts.palette) {
    const [bytes, field] = paletteBytes(opts.palette);
    out.push(0x80 | 0x70 | field, opts.bgindex ?? 0, 0, ...bytes);
  } else {
    out.push(0x70, opts.bgindex ?? 0, 0);
  }
  return out;
}

export interface FrameSpec {
  x?: number;
  y?: number;
  w: number;
  h: number;
  /** 按存储顺序（交错时是交错后的顺序）排的下标。 */
  indices: ArrayLike<number>;
  gce?: Gce;
  interlace?: boolean;
  /** 局部调色板。 */
  palette?: readonly Rgb[];
  /** LZW 最小码宽，默认按全局 / 局部调色板大小推。 */
  minCodeSize?: number;
  /** 直接给出码列表（覆盖 indices 的编码）。 */
  codes?: number[];
  /** 不发 GCE。 */
  noGce?: boolean;
  /** 码流字节后追加的垃圾字节（同一子块内，结束码之后）。 */
  trailing?: number[];
  /** 子块大小（默认 255）。 */
  blockSize?: number;
}

/** 一帧：GCE + 图像描述 + 局部调色板 + LZW。 */
export function frameBlock(f: FrameSpec, defaultMinCodeSize = 2): number[] {
  const out: number[] = [];
  if (!f.noGce && f.gce) out.push(...gceBlock(f.gce));
  let flags = f.interlace ? 0x40 : 0;
  let pal: number[] = [];
  if (f.palette) {
    const [bytes, field] = paletteBytes(f.palette);
    flags |= 0x80 | field;
    pal = bytes;
  }
  out.push(0x2c, ...u16(f.x ?? 0), ...u16(f.y ?? 0), ...u16(f.w), ...u16(f.h), flags, ...pal);
  let cs = f.minCodeSize;
  if (cs === undefined) {
    cs = defaultMinCodeSize;
    if (f.palette) cs = Math.max(2, Math.ceil(Math.log2(Math.max(f.palette.length, 2))));
  }
  const codes = f.codes ?? lzwCodes(f.indices, cs);
  const bytes = packCodes(codes, cs);
  if (f.trailing) bytes.push(...f.trailing);
  out.push(cs);
  for (const b of subblocks(bytes, f.blockSize)) out.push(b);
  return out;
}

export const TRAILER = [0x3b];

/** 交错存储顺序：第 k 个存储行对应画布（帧内）第 rowOrder(h)[k] 行。 */
export function interlaceRowOrder(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let r = start; r < h; r += step) rows.push(r);
  }
  return rows;
}
