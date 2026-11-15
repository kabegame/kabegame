/**
 * 单测用的 MP4 构造工具（P9d）：按 ISO/IEC 14496-12 拼出最小 MP4 的字节（ftyp / moov / mdat，样本表各盒子）。
 * `mp4.test.ts` 核对帧表，`codecPlayer.test.ts` 拿它造播放器的输入。只给测试用，产品代码不引用。
 */
import type { ReadRange } from "./mp4";

export function concat(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
export function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff);
  return out;
}
export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}
export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt.asUintN(64, value));
  return out;
}
export function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ———— 盒子构造 ————

export function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(u32be(8 + body.length), ascii(type), body);
}
/** full box：version(1) flags(3) + 内容。 */
export function full(type: string, version: number, ...content: Uint8Array[]): Uint8Array {
  return box(type, u32be((version << 24) >>> 0), ...content);
}

export const FTYP = box("ftyp", ascii("isom"), u32be(512), ascii("isomiso2avc1mp41"));
/** 一个 avcC：configurationVersion 1、High（100）、level 4.0、4 字节长度、0 个 SPS / PPS（帧表测试不看内容）。 */
export const AVCC = new Uint8Array([1, 0x64, 0x00, 0x28, 0xff, 0xe0, 0x00]);
/** 一个 hvcC 的定长 23 字节：Main、level 153，之后 0 个数组。 */
export const HVCC = new Uint8Array([
  1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 153, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0,
]);

/** 视觉样本项：SampleEntry 头 8 字节 + VisualSampleEntry 70 字节（宽高在其中），之后是子盒子。 */
export function sampleEntry(type: string, width: number, height: number, ...kids: Uint8Array[]): Uint8Array {
  const visual = new Uint8Array(78);
  const data = new DataView(visual.buffer);
  data.setUint16(6, 1); // data_reference_index
  data.setUint16(24, width);
  data.setUint16(26, height);
  data.setUint32(28, 0x00480000); // horizresolution 72 dpi
  data.setUint32(32, 0x00480000);
  data.setUint16(40, 1); // frame_count
  data.setUint16(74, 0x18); // depth
  data.setInt16(76, -1); // pre_defined
  return box(type, visual, ...kids);
}
export function colrNclx(primaries: number, transfer: number, matrix: number, fullRange: boolean): Uint8Array {
  return box(
    "colr",
    ascii("nclx"),
    u16be(primaries),
    u16be(transfer),
    u16be(matrix),
    new Uint8Array([fullRange ? 0x80 : 0]),
  );
}
export function hdlr(handler: string): Uint8Array {
  return full("hdlr", 0, u32be(0), ascii(handler), new Uint8Array(12), ascii("handler\0"));
}
export function mdhd(timescale: number, duration: number): Uint8Array {
  return full("mdhd", 0, u32be(0), u32be(0), u32be(timescale), u32be(duration), u16be(0x55c4), u16be(0));
}
export function mvhd(timescale: number, duration: number): Uint8Array {
  return full("mvhd", 0, u32be(0), u32be(0), u32be(timescale), u32be(duration), new Uint8Array(80));
}

/** 编辑列表的一段：段长、media_time、速率整数部分（小数部分 0）。 */
export type EditRow = [segmentDuration: number, mediaTime: number, rate?: number];

export interface Spec {
  /** 样本项类型与配置盒。 */
  entry?: string;
  config?: Uint8Array;
  configType?: string;
  /** 样本项里额外的子盒子（colr 等），放在配置盒之后。 */
  extra?: Uint8Array[];
  width?: number;
  height?: number;
  /** 每个样本的大小，样本内容按序号填充（便于核对偏移）。 */
  sizes: number[];
  /** 每块的样本数；`stsc` 缺省按它压成行。 */
  perChunk: number[];
  stsc?: [firstChunk: number, perChunk: number, description: number][];
  stts: [count: number, delta: number][];
  ctts?: { version: number; rows: [count: number, offset: number][] };
  /** 关键帧样本号（1 起）；null 表示没有 stss。 */
  stss?: number[] | null;
  elst?: { version: number; rows: EditRow[] };
  co64?: boolean;
  /** stsz 用定长写法（全部样本同样大）。 */
  fixedSize?: boolean;
  /** mdat 放在 moov 之前。 */
  mdatFirst?: boolean;
  /** 块与块之间插入的字节（其它轨的数据）。 */
  gap?: number;
  timescale?: number;
  mediaDuration?: number;
  /** mvhd 的 [timescale, duration]；null 表示没有 mvhd。 */
  movie?: [number, number] | null;
  /** 视频轨之前的其它 trak。 */
  before?: Uint8Array[];
  /** moov 里额外的子盒子。 */
  moovExtra?: Uint8Array[];
}

/** 样本内容：第 i 个样本的每个字节都是 (i + 1) & 0xff，长度照 sizes。 */
export function sampleBytes(sizes: number[]): Uint8Array[] {
  return sizes.map((size, i) => new Uint8Array(size).fill((i + 1) & 0xff));
}

export function stscRows(perChunk: number[]): [number, number, number][] {
  const rows: [number, number, number][] = [];
  perChunk.forEach((count, chunk) => {
    if (rows.length === 0 || rows[rows.length - 1][1] !== count) rows.push([chunk + 1, count, 1]);
  });
  return rows;
}

export function stbl(spec: Spec, chunkOffsets: number[]): Uint8Array {
  const entryType = spec.entry ?? "avc1";
  const config = spec.config ?? (entryType.startsWith("hv") || entryType === "hev1" ? HVCC : AVCC);
  const configType = spec.configType ?? (config === HVCC ? "hvcC" : "avcC");
  const entry = sampleEntry(
    entryType,
    spec.width ?? 1920,
    spec.height ?? 1080,
    box(configType, config),
    ...(spec.extra ?? []),
  );
  const stsd = full("stsd", 0, u32be(1), entry);
  const stsz = spec.fixedSize
    ? full("stsz", 0, u32be(spec.sizes[0]), u32be(spec.sizes.length))
    : full("stsz", 0, u32be(0), u32be(spec.sizes.length), ...spec.sizes.map(u32be));
  const rows = spec.stsc ?? stscRows(spec.perChunk);
  const stsc = full("stsc", 0, u32be(rows.length), ...rows.flatMap(([a, b, c]) => [u32be(a), u32be(b), u32be(c)]));
  const stco = spec.co64
    ? full("co64", 0, u32be(chunkOffsets.length), ...chunkOffsets.map((o) => u64be(BigInt(o))))
    : full("stco", 0, u32be(chunkOffsets.length), ...chunkOffsets.map(u32be));
  const stts = full("stts", 0, u32be(spec.stts.length), ...spec.stts.flatMap(([n, d]) => [u32be(n), u32be(d)]));
  const tables = [stsd, stts];
  if (spec.ctts) {
    const { version, rows: cttsRows } = spec.ctts;
    tables.push(full("ctts", version, u32be(cttsRows.length), ...cttsRows.flatMap(([n, o]) => [u32be(n), u32be(o)])));
  }
  const stss = spec.stss === undefined ? [1] : spec.stss;
  if (stss) tables.push(full("stss", 0, u32be(stss.length), ...stss.map(u32be)));
  tables.push(stsc, stsz, stco);
  return box("stbl", ...tables);
}

export function elst(version: number, rows: EditRow[]): Uint8Array {
  const entries = rows.map(([segment, media, rate = 1]) =>
    version === 1
      ? concat(u64be(BigInt(segment)), u64be(BigInt(media)), u16be(rate), u16be(0))
      : concat(u32be(segment), u32be(media), u16be(rate), u16be(0)),
  );
  return box("edts", full("elst", version, u32be(rows.length), ...entries));
}

export function videoTrak(spec: Spec, chunkOffsets: number[]): Uint8Array {
  const timescale = spec.timescale ?? 15360;
  const total = spec.stts.reduce((sum, [n, d]) => sum + n * d, 0);
  return box(
    "trak",
    box("tkhd", new Uint8Array(84)),
    ...(spec.elst ? [elst(spec.elst.version, spec.elst.rows)] : []),
    box(
      "mdia",
      mdhd(timescale, spec.mediaDuration ?? total),
      hdlr("vide"),
      box("minf", box("vmhd", new Uint8Array(12)), stbl(spec, chunkOffsets)),
    ),
  );
}

export function moovOf(spec: Spec, chunkOffsets: number[]): Uint8Array {
  const movie = spec.movie === undefined ? [1000, 2000] : spec.movie;
  return box(
    "moov",
    ...(movie ? [mvhd(movie[0], movie[1])] : []),
    ...(spec.before ?? []),
    videoTrak(spec, chunkOffsets),
    ...(spec.moovExtra ?? []),
  );
}

/** 拼一个完整的 MP4，返回字节与每个样本应有的内容。 */
export function buildMp4(spec: Spec): { bytes: Uint8Array; samples: Uint8Array[]; mdatContent: [number, number] } {
  const samples = sampleBytes(spec.sizes);
  const gap = spec.gap ?? 0;
  // mdat 内容：块与块之间插 gap 字节
  const parts: Uint8Array[] = [];
  const relative: number[] = [];
  let at = 0;
  let sample = 0;
  for (const count of spec.perChunk) {
    relative.push(at);
    for (let j = 0; j < count; j++, sample++) {
      parts.push(samples[sample]);
      at += samples[sample].length;
    }
    if (gap) {
      parts.push(new Uint8Array(gap).fill(0xee));
      at += gap;
    }
  }
  const mdatBody = concat(...parts);
  const mdat = box("mdat", mdatBody);
  // moov 的大小和偏移的值无关：先拼一次量长度
  const moovLength = moovOf(spec, relative).length;
  const mdatAt = spec.mdatFirst ? FTYP.length : FTYP.length + moovLength;
  const moov = moovOf(
    spec,
    relative.map((offset) => mdatAt + 8 + offset),
  );
  const bytes = spec.mdatFirst ? concat(FTYP, mdat, moov) : concat(FTYP, moov, mdat);
  return { bytes, samples, mdatContent: [mdatAt + 8, mdatAt + 8 + mdatBody.length] };
}

export function memoryRead(bytes: Uint8Array): { read: ReadRange; calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    read: async (start, end) => {
      calls.push([start, end]);
      return bytes.slice(start, end);
    },
  };
}
