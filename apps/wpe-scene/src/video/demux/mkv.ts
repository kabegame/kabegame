/**
 * Matroska / WebM 的帧表（P9d 步骤 3）：产出和 `mp4.ts` 同一个 `VideoTrackIndex`，播放器不分格式。纯函数，Node 里可测。
 *
 * - **读法**：Matroska 没有集中的帧表，每一帧散在各个 Cluster 里，只能把 Segment 顺着读一遍。按区间逐块去读块头要上万次读，
 *   太慢；这里按 `CHUNK_BYTES`（约 4 MiB）一块顺序读进内存解析，只记块头（偏移、长度、时间、关键帧），块数据不留。元素跨块边界时
 *   把上一块的尾巴留下、接上下一块（`Stream.need`）；要跳过的元素（音轨的块、Cues、Tags …）越过手里的块时，下一次从跳到的位置
 *   接着读。语料那段 299 MiB 等于整段读一遍，只在加载时做一次（phase-9d「步骤 3」）。
 * - **结构**：EBML 头（DocType `matroska` / `webm`，≤ `MAX_EBML_HEADER`）→ 紧跟的 Segment → 顶层元素：`Info`（`TimecodeScale`
 *   缺省 1e6 ns、`Duration`）、`Tracks`（第一条 `TrackType = 1` 的视频轨）、`Cluster`（`Timecode`、`SimpleBlock`、`BlockGroup` 里的
 *   `Block` 与 `ReferenceBlock`）；其余（SeekHead、Cues、Tags、Void、CRC-32 …）跳过。按固定的结构往下走，嵌套最多
 *   Segment → Tracks → TrackEntry → Video → Colour 五层，不会被畸形文件带着无限递归。
 * - **未知大小**（size 的值位全 1，流式写出）：Segment 读到下一个 EBML 头 / Segment 或视频末尾；Cluster 读到下一个 Segment 级元素
 *   （下一个 Cluster、Cues、Tags …）或上级元素为止，即「读到下一个同级或上级 ID」。其它元素未知大小时失败。
 * - **轨**：只认第一条视频轨，CodecID 只认 `V_MPEG4/ISO/AVC` 与 `V_MPEGH/ISO/HEVC`，`CodecPrivate` 就是 avcC / hvcC（Matroska 规范
 *   codec 映射），`sampleEntry` 记 avc1 / hvc1（codec 串照 MP4 的写法，`decoderConfig` 直接可用）；带 `ContentEncodings`（压缩或
 *   加密，如 mkvmerge 的头部剥离）的轨不支持。在 Tracks 里就认定，编码不支持或没有视频轨时不往下读 Cluster。
 * - **帧**：只收这条轨的块（别的轨的块连 lacing 也不看，音轨常用 lacing）。块头 = 轨号（EBML 变长整数，去标记位）+ 有符号 16 位
 *   相对时间码 + 标志；SimpleBlock 标志 0x80 是关键帧，BlockGroup 没有 `ReferenceBlock` 是关键帧；lacing（标志 0x06 非 0）失败。
 *   偏移 / 长度是块数据（去掉块头）在视频里的区间。块在文件里按解码顺序排，时间码是显示时间。
 * - **时间**：`times` = (Cluster 时间码 + 相对时间码 − 最小值) × `TimecodeScale` / 1e9 秒：减去全部帧里最小的显示时间，让最早显示的帧
 *   为 0（照 MP4 扣编辑列表之后首帧为 0 的口径；有 B 帧时解码顺序第一帧的显示时间未必最小）。`editMediaTime` 记扣掉的量，单位是
 *   Matroska 时间码（`TimecodeScale` 纳秒），`timescale` = 1e9 / `TimecodeScale`（每秒的时间码数），`editMediaTime / timescale`
 *   即扣掉的秒数，和 MP4 的「mdhd 时间单位 / mdhd timescale」同一个关系。播放器只用 `times`。
 * - **时长**：`Info.Duration × TimecodeScale / 1e9`（和 `containerDuration` 一致）；没有或不是正数时退到「最大显示时间 + 一帧」，一帧取
 *   相邻显示时间之差的中位数，只有一帧时取轨的 `DefaultDuration`，都没有为 0。
 * - **颜色**：`Video/Colour` 的 `MatrixCoefficients` / `Primaries` / `TransferCharacteristics`（码值同 ISO/IEC 23091-2，缺省 2 未指定）
 *   与 `Range`（2 是 full）填进 `colr`，`wpeColor` 照 MP4 的 `colr` 处理（矩阵码 2 当没标、往 SPS VUI 找）；没有 `Colour` 时 null。
 * - **失败**：一律返回 `{ error: 中文原因 }`，从不抛错（`read` reject 也一样）。上限：EBML 头 ≤ 4 KiB、整个读进内存的元素（Info、
 *   Tracks）≤ `MAX_MASTER_BYTES`、帧数 ≤ `MAX_FRAMES`。
 */
import { DEFAULT_TIMECODE_SCALE, elementId, elementSize, MAX_EBML_HEADER } from "../container";
import type { Mp4Colr, ReadRange, VideoSampleEntry, VideoTrackIndex } from "./mp4";

/** 顺序读的块大小。 */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** 帧数上限（同 `mp4.ts` 的 `MAX_SAMPLES`）：只防畸形文件让表无限长。 */
export const MAX_FRAMES = 10_000_000;
/** 整个读进内存解析的元素（Info、Tracks）的上限：CodecPrivate 通常几十到几百字节。 */
export const MAX_MASTER_BYTES = 16 * 1024 * 1024;

export const EBML_MAGIC = 0x1a45dfa3;
const ID = {
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
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
} as const;

/** 未知大小的 Cluster 读到这些 ID 为止：Segment 的子元素（同级）与 EBML 头 / Segment（上级）。 */
const CLUSTER_END_IDS = new Set<number>([
  ID.Cluster,
  ID.Cues,
  ID.Info,
  ID.Tracks,
  ID.SeekHead,
  ID.Chapters,
  ID.Tags,
  ID.Attachments,
  ID.Segment,
  ID.EBML,
]);

const CODECS: Record<string, { codec: "avc" | "hevc"; sampleEntry: VideoSampleEntry; config: string; min: number }> = {
  "V_MPEG4/ISO/AVC": { codec: "avc", sampleEntry: "avc1", config: "avcC", min: 7 },
  "V_MPEGH/ISO/HEVC": { codec: "hevc", sampleEntry: "hvc1", config: "hvcC", min: 23 },
};

/** 内部失败：`indexMatroska` 统一接住变成 `{ error }`。 */
class MkvError extends Error {}

function fail(message: string): never {
  throw new MkvError(message);
}

/** 读的统计（语料扫描与测试用）。 */
export interface MatroskaReadStats {
  reads: number;
  bytes: number;
}

/**
 * 顺序读 Segment，解析第一条视频轨的帧表；不是 Matroska、没有视频轨、编码不是 H.264 / H.265、有 lacing 等时返回带原因的失败。
 * `length` 是视频数据总长。从不抛错（`read` reject 也一样）。`stats` 给出时累计读的次数与字节数。
 */
export async function indexMatroska(
  read: ReadRange,
  length: number,
  options: { chunkBytes?: number; stats?: MatroskaReadStats } = {},
): Promise<VideoTrackIndex | { error: string }> {
  try {
    if (!Number.isSafeInteger(length) || length < 8) return { error: `视频数据太短（${length} 字节）` };
    const stream = new Stream(read, length, options.chunkBytes ?? CHUNK_BYTES, options.stats);
    return await parse(stream);
  } catch (error) {
    if (error instanceof MkvError) return { error: error.message };
    return { error: `读取或解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ———— 顺序读 ————

/** 手里一段连续的字节 `[start, start + bytes.length)`；`need` 不够时接着往后读一块（保留还要用的尾巴）。 */
class Stream {
  bytes: Uint8Array = new Uint8Array(0);
  start = 0;

  private readonly read: ReadRange;
  readonly length: number;
  private readonly chunk: number;
  private readonly stats: MatroskaReadStats | undefined;

  constructor(read: ReadRange, length: number, chunk: number, stats?: MatroskaReadStats) {
    this.read = read;
    this.length = length;
    this.chunk = chunk;
    this.stats = stats;
  }

  /** `[at, at + n)` 已在手里。 */
  has(at: number, n: number): boolean {
    return at >= this.start && at + n <= this.start + this.bytes.length;
  }

  /** 保证 `[at, at + n)` 在手里；越过视频末尾时失败。调用方先看 `has`，手里有时不必 await。 */
  async need(at: number, n: number): Promise<void> {
    if (this.has(at, n)) return;
    const end = this.start + this.bytes.length;
    if (at + n > this.length) fail(`读取越过视频数据末尾（偏移 ${at}，要 ${n} 字节）`);
    // 和手里的有重叠（元素跨块边界）：留下 [at, end)，从 end 接着读；否则（跳过的元素越过了手里的块）从 at 重新读
    const overlap = at >= this.start && at < end;
    const from = overlap ? end : at;
    const to = Math.min(this.length, Math.max(at + n, from + this.chunk));
    const fresh = await this.read(from, to);
    if (fresh.length !== to - from) fail(`读取被截断：[${from}, ${to}) 只拿到 ${fresh.length} 字节`);
    if (this.stats) {
      this.stats.reads++;
      this.stats.bytes += fresh.length;
    }
    if (overlap) {
      const kept = this.bytes.subarray(at - this.start);
      const joined = new Uint8Array(kept.length + fresh.length);
      joined.set(kept);
      joined.set(fresh, kept.length);
      this.bytes = joined;
    } else this.bytes = fresh;
    this.start = at;
  }

  /** 手里 `at` 处在 `bytes` 里的下标（调用前已 `need`）。 */
  index(at: number): number {
    return at - this.start;
  }
}

interface Element {
  id: number;
  /** 元素头的起点。 */
  start: number;
  /** 内容起点（头之后）。 */
  content: number;
  /** 内容终点；未知大小时为 `limit`。 */
  end: number;
  unknown: boolean;
}

/** `bytes` 里 `at` 处（坐标 = 下标 + `base`）的元素头；越界或畸形时 null。 */
function headerIn(bytes: Uint8Array, at: number, base: number, limit: number): Element | null {
  const i = at - base;
  const id = elementId(bytes, i);
  if (!id) return null;
  const size = elementSize(bytes, i + id.length);
  if (!size) return null;
  const content = at + id.length + size.length;
  const end = size.unknown ? limit : content + size.value;
  if (end > limit) return null;
  return { id: id.value, start: at, content, end, unknown: size.unknown };
}

/** 流里 `at` 处的元素头（ID ≤ 4 字节 + 大小 ≤ 8 字节）。 */
async function header(stream: Stream, at: number, limit: number, where: string): Promise<Element> {
  const n = Math.min(12, stream.length - at);
  if (!stream.has(at, n)) await stream.need(at, n);
  const element = headerIn(stream.bytes, at, stream.start, limit);
  if (!element) fail(`${where} 里的元素头畸形或越界（偏移 ${at}）`);
  return element;
}

/** 整个读进内存的元素内容（拷贝一份，之后流可以往前走）。 */
async function load(stream: Stream, element: Element, what: string): Promise<Uint8Array> {
  const size = element.end - element.content;
  if (size > MAX_MASTER_BYTES) fail(`${what} 太大（${size} 字节，上限 ${MAX_MASTER_BYTES}）`);
  await stream.need(element.content, size);
  const i = stream.index(element.content);
  return stream.bytes.slice(i, i + size);
}

/** 内存里 `[start, end)` 的一串子元素（坐标即下标）；未知大小或畸形时失败。 */
function childrenOf(bytes: Uint8Array, start: number, end: number, where: string): Element[] {
  const out: Element[] = [];
  for (let at = start; at < end;) {
    const element = headerIn(bytes, at, 0, end);
    if (!element) fail(`${where} 里的元素畸形或越界（偏移 ${at}）`);
    if (element.unknown) fail(`${where} 里有未知大小的元素`);
    out.push(element);
    at = element.end;
  }
  return out;
}

/** 无符号整数（0–8 字节，大端）。 */
function uint(bytes: Uint8Array, element: Element, what: string): number {
  const size = element.end - element.content;
  if (size > 8) fail(`${what} 太长（${size} 字节）`);
  let value = 0;
  for (let i = element.content; i < element.end; i++) value = value * 256 + bytes[i];
  if (!Number.isSafeInteger(value)) fail(`${what} 超过安全整数`);
  return value;
}

/** 浮点（0 / 4 / 8 字节，大端；0 字节为 0）。 */
function float(bytes: Uint8Array, element: Element, what: string): number {
  const size = element.end - element.content;
  if (size === 0) return 0;
  const data = new DataView(bytes.buffer, bytes.byteOffset + element.content, size);
  if (size === 4) return data.getFloat32(0);
  if (size === 8) return data.getFloat64(0);
  fail(`${what} 的长度 ${size} 不对`);
}

/** 字符串（ASCII，去掉末尾补的 0）。 */
function text(bytes: Uint8Array, element: Element): string {
  let end = element.end;
  while (end > element.content && bytes[end - 1] === 0) end--;
  return String.fromCharCode(...bytes.subarray(element.content, end));
}

// ———— 解析 ————

interface VideoTrack {
  number: number;
  codec: (typeof CODECS)[string];
  description: Uint8Array;
  width: number;
  height: number;
  colr: Mp4Colr | null;
  defaultDuration: number | undefined;
}

/** 帧表：按解码顺序追加，容量翻倍增长。 */
class Frames {
  count = 0;
  offsets = new Float64Array(1024);
  sizes = new Uint32Array(1024);
  ticks = new Float64Array(1024);
  keys = new Uint8Array(1024);

  push(offset: number, size: number, tick: number, key: boolean): void {
    if (this.count >= MAX_FRAMES) fail(`帧数超过上限 ${MAX_FRAMES}`);
    if (this.count === this.offsets.length) {
      const grow = <T extends Float64Array | Uint32Array | Uint8Array>(old: T, next: T): T => {
        next.set(old);
        return next;
      };
      const capacity = this.count * 2;
      this.offsets = grow(this.offsets, new Float64Array(capacity));
      this.sizes = grow(this.sizes, new Uint32Array(capacity));
      this.ticks = grow(this.ticks, new Float64Array(capacity));
      this.keys = grow(this.keys, new Uint8Array(capacity));
    }
    const i = this.count++;
    this.offsets[i] = offset;
    this.sizes[i] = size;
    this.ticks[i] = tick;
    this.keys[i] = key ? 1 : 0;
  }
}

interface State {
  stream: Stream;
  scale: number;
  duration: number | undefined;
  track: VideoTrack | null;
  frames: Frames;
}

async function parse(stream: Stream): Promise<VideoTrackIndex> {
  // —— EBML 头 ——
  await stream.need(0, Math.min(12, stream.length));
  const ebml = headerIn(stream.bytes, 0, 0, Number.MAX_SAFE_INTEGER);
  if (!ebml || ebml.id !== ID.EBML) fail("不是 Matroska：开头不是 EBML 头");
  if (ebml.unknown || ebml.end > MAX_EBML_HEADER) fail(`EBML 头太大或大小未知（上限 ${MAX_EBML_HEADER} 字节）`);
  if (ebml.end > stream.length) fail("EBML 头越过视频数据末尾");
  const head = await load(stream, ebml, "EBML 头");
  let docType = "matroska"; // 规范缺省
  for (const child of childrenOf(head, 0, head.length, "EBML 头")) {
    if (child.id === ID.DocType) docType = text(head, child);
  }
  if (docType !== "matroska" && docType !== "webm") fail(`DocType ${docType} 不是 matroska / webm`);

  // —— Segment ——
  const segment = await header(stream, ebml.end, stream.length, "文件");
  if (segment.id !== ID.Segment) fail("EBML 头之后不是 Segment");
  const state: State = {
    stream,
    scale: DEFAULT_TIMECODE_SCALE,
    duration: undefined,
    track: null,
    frames: new Frames(),
  };
  let tracksSeen = false;
  const end = segment.end;
  for (let at = segment.content; at < end;) {
    const element = await header(stream, at, end, "Segment");
    if (segment.unknown && (element.id === ID.EBML || element.id === ID.Segment)) break;
    if (element.id === ID.Cluster) {
      if (!tracksSeen) fail("Cluster 出现在 Tracks 之前");
      at = await cluster(state, element, end);
      continue;
    }
    if (element.unknown) fail(`Segment 里有未知大小的元素（ID 0x${element.id.toString(16)}）`);
    if (element.id === ID.Info) parseInfo(state, await load(stream, element, "Info"));
    else if (element.id === ID.Tracks && !tracksSeen) {
      tracksSeen = true;
      state.track = parseTracks(await load(stream, element, "Tracks"));
    }
    at = element.end;
  }
  if (!tracksSeen) fail("没有 Tracks");
  return finish(state);
}

function parseInfo(state: State, bytes: Uint8Array): void {
  for (const child of childrenOf(bytes, 0, bytes.length, "Info")) {
    if (child.id === ID.TimecodeScale) {
      state.scale = uint(bytes, child, "TimecodeScale");
      if (state.scale === 0) fail("TimecodeScale 为 0");
    } else if (child.id === ID.Duration) state.duration = float(bytes, child, "Duration");
  }
}

/** 第一条视频轨；没有或编码不支持时失败（不往下读 Cluster）。 */
function parseTracks(bytes: Uint8Array): VideoTrack {
  for (const entry of childrenOf(bytes, 0, bytes.length, "Tracks")) {
    if (entry.id !== ID.TrackEntry) continue;
    const kids = childrenOf(bytes, entry.content, entry.end, "TrackEntry");
    const find = (id: number) => kids.find((kid) => kid.id === id);
    const type = find(ID.TrackType);
    if (!type || uint(bytes, type, "TrackType") !== 1) continue;
    const numberElement = find(ID.TrackNumber) ?? fail("视频轨缺少 TrackNumber");
    const number = uint(bytes, numberElement, "TrackNumber");
    if (number === 0) fail("视频轨的 TrackNumber 为 0");
    const codecElement = find(ID.CodecID) ?? fail("视频轨缺少 CodecID");
    const codecId = text(bytes, codecElement);
    const codec = CODECS[codecId];
    if (!codec) fail(`视频编码 ${codecId} 不支持（只支持 V_MPEG4/ISO/AVC / V_MPEGH/ISO/HEVC）`);
    if (find(ID.ContentEncodings)) fail("视频轨带 ContentEncodings（压缩或加密）不支持");
    const privateElement = find(ID.CodecPrivate) ?? fail(`${codecId} 视频轨缺少 CodecPrivate（${codec.config}）`);
    const description = bytes.slice(privateElement.content, privateElement.end);
    if (description.length < codec.min) fail(`${codec.config} 太短（${description.length} 字节）`);
    const video = find(ID.Video) ?? fail("视频轨缺少 Video");
    const videoKids = childrenOf(bytes, video.content, video.end, "Video");
    const findVideo = (id: number) => videoKids.find((kid) => kid.id === id);
    const width = findVideo(ID.PixelWidth);
    const height = findVideo(ID.PixelHeight);
    if (!width || !height) fail("视频轨缺少 PixelWidth / PixelHeight");
    const colour = findVideo(ID.Colour);
    const defaultDuration = find(ID.DefaultDuration);
    return {
      number,
      codec,
      description,
      width: uint(bytes, width, "PixelWidth"),
      height: uint(bytes, height, "PixelHeight"),
      colr: colour ? parseColour(bytes, colour) : null,
      defaultDuration: defaultDuration ? uint(bytes, defaultDuration, "DefaultDuration") : undefined,
    };
  }
  fail("没有视频轨（TrackType 为 1 的 TrackEntry）");
}

/** `Colour` → `colr` 的四个字段：码值缺省 2（未指定），`Range` 缺省 0（未指定），2 是 full。 */
function parseColour(bytes: Uint8Array, colour: Element): Mp4Colr {
  const out: Mp4Colr = { primaries: 2, transfer: 2, matrix: 2, fullRange: false };
  for (const child of childrenOf(bytes, colour.content, colour.end, "Colour")) {
    if (child.id === ID.MatrixCoefficients) out.matrix = uint(bytes, child, "MatrixCoefficients");
    else if (child.id === ID.Primaries) out.primaries = uint(bytes, child, "Primaries");
    else if (child.id === ID.TransferCharacteristics) out.transfer = uint(bytes, child, "TransferCharacteristics");
    else if (child.id === ID.Range) out.fullRange = uint(bytes, child, "Range") === 2;
  }
  return out;
}

/** 读一个 Cluster，返回下一个 Segment 级元素的位置。 */
async function cluster(state: State, element: Element, segmentEnd: number): Promise<number> {
  const { stream } = state;
  const end = element.unknown ? segmentEnd : element.end;
  let timecode: number | undefined;
  for (let at = element.content; at < end;) {
    const child = await header(stream, at, end, "Cluster");
    if (element.unknown && CLUSTER_END_IDS.has(child.id)) return at;
    if (child.unknown) fail(`Cluster 里有未知大小的元素（ID 0x${child.id.toString(16)}）`);
    if (child.id === ID.Timecode) {
      await stream.need(child.content, child.end - child.content);
      timecode = uint(stream.bytes, inStream(stream, child), "Cluster 的 Timecode");
    } else if (child.id === ID.SimpleBlock) {
      await block(state, child, timecode, null);
    } else if (child.id === ID.BlockGroup) {
      await blockGroup(state, child, timecode);
    }
    at = child.end;
  }
  return end;
}

/** 流里的元素换成手里字节的下标坐标。 */
function inStream(stream: Stream, element: Element): Element {
  return {
    ...element,
    start: stream.index(element.start),
    content: stream.index(element.content),
    end: stream.index(element.end),
  };
}

async function blockGroup(state: State, group: Element, timecode: number | undefined): Promise<void> {
  const { stream } = state;
  let found: Element | null = null;
  let referenced = false;
  for (let at = group.content; at < group.end;) {
    const child = await header(stream, at, group.end, "BlockGroup");
    if (child.unknown) fail("BlockGroup 里有未知大小的元素");
    if (child.id === ID.Block && !found) found = child;
    else if (child.id === ID.ReferenceBlock) referenced = true;
    at = child.end;
  }
  if (found) await block(state, found, timecode, !referenced);
}

/**
 * 块头：轨号（变长整数）+ 有符号 16 位相对时间码 + 标志。`key` 为 null 时是 SimpleBlock（关键帧看标志 0x80），否则是 BlockGroup
 * 按有没有 ReferenceBlock 定好的。别的轨的块直接跳过。
 */
async function block(state: State, element: Element, timecode: number | undefined, key: boolean | null): Promise<void> {
  const { stream, track } = state;
  if (!track) return;
  const size = element.end - element.content;
  const n = Math.min(size, 11);
  if (!stream.has(element.content, n)) await stream.need(element.content, n);
  const i = stream.index(element.content);
  // 轨号是去掉标记位的 EBML 变长整数，和元素大小同一种编码；只在块头的范围里读
  const number = elementSize(stream.bytes.subarray(0, i + n), i);
  if (!number || number.length + 3 > size) fail(`块头畸形（偏移 ${element.start}）`);
  if (number.value !== track.number) return;
  if (timecode === undefined) fail(`Cluster 里的块出现在 Timecode 之前（偏移 ${element.start}）`);
  const at = i + number.length;
  const relative = new DataView(stream.bytes.buffer, stream.bytes.byteOffset + at, 2).getInt16(0);
  const flags = stream.bytes[at + 2];
  if (flags & 0x06) fail(`视频块用了 lacing（偏移 ${element.start}），不支持`);
  const data = element.content + number.length + 3;
  state.frames.push(data, element.end - data, timecode + relative, key ?? (flags & 0x80) !== 0);
}

function finish(state: State): VideoTrackIndex {
  const { track, frames, scale } = state;
  if (!track) fail("没有视频轨");
  const count = frames.count;
  if (count === 0) fail("视频轨没有帧");
  let min = Infinity;
  for (let i = 0; i < count; i++) if (frames.ticks[i] < min) min = frames.ticks[i];
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = ((frames.ticks[i] - min) * scale) / 1e9;

  let duration =
    state.duration !== undefined && Number.isFinite(state.duration) && state.duration > 0
      ? (state.duration * scale) / 1e9
      : undefined;
  if (duration === undefined) {
    const sorted = Float64Array.from(times).sort();
    const steps: number[] = [];
    for (let i = 1; i < count; i++) if (sorted[i] > sorted[i - 1]) steps.push(sorted[i] - sorted[i - 1]);
    steps.sort((a, b) => a - b);
    const step = steps.length
      ? steps[(steps.length - 1) >> 1]
      : track.defaultDuration !== undefined
        ? track.defaultDuration / 1e9
        : 0;
    duration = sorted[count - 1] + step;
  }
  return {
    codec: track.codec.codec,
    sampleEntry: track.codec.sampleEntry,
    description: track.description,
    codedWidth: track.width,
    codedHeight: track.height,
    timescale: 1e9 / scale,
    duration,
    offsets: frames.offsets.slice(0, count),
    sizes: frames.sizes.slice(0, count),
    times,
    keys: frames.keys.slice(0, count),
    colr: track.colr,
    editMediaTime: min,
  };
}
