/**
 * 单测用的 Matroska 构造工具（P9d 步骤 3）：按 EBML 规则拼出最小 Matroska 的字节（EBML 头、Segment、Info、Tracks、Cluster、块）。
 * `mkv.test.ts` 核对帧表，`codecPlayer.test.ts` 拿它造播放器的输入。只给测试用，产品代码不引用。
 */
import { ascii, concat } from "./testMp4";

/** EBML 元素 ID 的字节（ID 自带长度标记，按数值的自然字节数写）。 */
function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) out.unshift(value % 256);
  return Uint8Array.from(out);
}

/** EBML 变长大小：最短编码，或指定长度 `width`（1–8）。 */
export function vint(value: number, width?: number): Uint8Array {
  let length = width ?? 1;
  if (width === undefined) while (value >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

/** 未知大小（值位全 1），`width` 字节。 */
export function unknownSize(width = 8): Uint8Array {
  const out = new Uint8Array(width).fill(0xff);
  out[0] = (0xff >> (width - 1)) | (0x80 >> (width - 1));
  return out;
}

export function el(id: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(idBytes(id), vint(body.length), body);
}

/** 大小写成未知（全 1）的元素。 */
export function elUnknown(id: number, ...content: Uint8Array[]): Uint8Array {
  return concat(idBytes(id), unknownSize(), ...content);
}

export function uintEl(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return el(id, Uint8Array.from(bytes.length ? bytes : [0]));
}

export function floatEl(id: number, value: number, width: 4 | 8 = 8): Uint8Array {
  const out = new Uint8Array(width);
  if (width === 4) new DataView(out.buffer).setFloat32(0, value);
  else new DataView(out.buffer).setFloat64(0, value);
  return el(id, out);
}

export function stringEl(id: number, value: string): Uint8Array {
  return el(id, ascii(value));
}

export const MKV = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  ContentEncodings: 0x6d80,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Void: 0xec,
} as const;

export function ebmlHeader(docType = "matroska"): Uint8Array {
  return el(MKV.EBML, uintEl(0x4286, 1), uintEl(0x42f7, 1), stringEl(MKV.DocType, docType));
}

export function info(timecodeScale?: number, duration?: number, durationWidth: 4 | 8 = 8): Uint8Array {
  return el(
    MKV.Info,
    ...(timecodeScale !== undefined ? [uintEl(MKV.TimecodeScale, timecodeScale)] : []),
    ...(duration !== undefined ? [floatEl(MKV.Duration, duration, durationWidth)] : []),
  );
}

export interface TrackSpec {
  number: number;
  /** 1 视频、2 音频。 */
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  width?: number;
  height?: number;
  /** `Colour` 的子元素（ID → 值）。 */
  colour?: [id: number, value: number][];
  defaultDuration?: number;
  extra?: Uint8Array[];
}

export function trackEntry(spec: TrackSpec): Uint8Array {
  const video =
    spec.type === 1
      ? [
          el(
            MKV.Video,
            uintEl(MKV.PixelWidth, spec.width ?? 64),
            uintEl(MKV.PixelHeight, spec.height ?? 48),
            ...(spec.colour ? [el(MKV.Colour, ...spec.colour.map(([id, value]) => uintEl(id, value)))] : []),
          ),
        ]
      : [];
  return el(
    MKV.TrackEntry,
    uintEl(MKV.TrackNumber, spec.number),
    uintEl(MKV.TrackType, spec.type),
    stringEl(MKV.CodecID, spec.codecId),
    ...(spec.codecPrivate ? [el(MKV.CodecPrivate, spec.codecPrivate)] : []),
    ...(spec.defaultDuration !== undefined ? [uintEl(MKV.DefaultDuration, spec.defaultDuration)] : []),
    ...video,
    ...(spec.extra ?? []),
  );
}

/** 块的内容：轨号（变长整数）+ 有符号 16 位相对时间码 + 标志 + 数据。 */
export function blockBody(track: number, relative: number, flags: number, data: Uint8Array): Uint8Array {
  const time = new Uint8Array(2);
  new DataView(time.buffer).setInt16(0, relative);
  return concat(vint(track), time, Uint8Array.of(flags), data);
}

export function simpleBlock(track: number, relative: number, flags: number, data: Uint8Array): Uint8Array {
  return el(MKV.SimpleBlock, blockBody(track, relative, flags, data));
}

/** BlockGroup：`references` 给出时带 ReferenceBlock（有符号整数，这里只写正值）。 */
export function blockGroup(track: number, relative: number, data: Uint8Array, references: number[] = []): Uint8Array {
  return el(
    MKV.BlockGroup,
    el(MKV.Block, blockBody(track, relative, 0, data)),
    ...references.map((value) => uintEl(MKV.ReferenceBlock, value)),
  );
}

export function cluster(timecode: number, ...blocks: Uint8Array[]): Uint8Array {
  return el(MKV.Cluster, uintEl(MKV.Timecode, timecode), ...blocks);
}

export function clusterUnknown(timecode: number, ...blocks: Uint8Array[]): Uint8Array {
  return elUnknown(MKV.Cluster, uintEl(MKV.Timecode, timecode), ...blocks);
}

/** 可识别的帧数据：`tag` 开头、补到 `size` 字节。 */
export function payload(tag: number, size = 8): Uint8Array {
  const out = new Uint8Array(size).fill(tag);
  out[0] = 0xf0;
  out[1] = tag;
  return out;
}

/** 拼一个完整文件：EBML 头 + Segment（`unknownSegment` 时大小写成未知）。 */
export function buildMkv(
  children: Uint8Array[],
  options: { docType?: string; unknownSegment?: boolean } = {},
): Uint8Array {
  const head = ebmlHeader(options.docType);
  const segment = options.unknownSegment ? elUnknown(MKV.Segment, ...children) : el(MKV.Segment, ...children);
  return concat(head, segment);
}
