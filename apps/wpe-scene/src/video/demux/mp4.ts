/**
 * MP4（ISO BMFF）的帧表（P9d 步骤 1 点 1）：视频纹理改由 WebCodecs 解码之后，宿主自己从 `.tex` / `scene.pkg` 的磁盘区间里
 * 拆出每一帧的压缩数据，这里给出拆包需要的全部信息——第一条视频轨的解码配置记录（`avcC` / `hvcC`）、编码尺寸、`colr`，
 * 以及每个样本按解码顺序的字节区间、显示时间与是否关键帧。纯函数，不碰浏览器对象，Node 里可测。
 *
 * - **读法**：顶层盒子只读头（≤ 16 字节），`mdat` 按头里的大小跳过、不读内容（语料 21 段的 `moov` 在 `mdat` 之后，`mdat`
 *   可达数百 MiB），找到 `moov` 再整个读进来（语料最大 79 KB，上限 64 MiB）在内存里解析。和 `video/container.ts` 同一套盒子规则
 *   （32 位大小 / `largesize` / 大小 0 到结尾、类型须是可打印 ASCII），上限也照它；那边的函数不导出，这里另写一份，行为一致。
 * - **样本表**：`stsz`（定长或逐个）、`stsc` + `stco` / `co64` 算偏移、`stts` 算解码时间、`ctts`（v0 无符号、v1 有符号）加显示偏移、
 *   `stss`（缺省全是关键帧）。偏移相对 MP4 开头，也就是 `read` 的 0；每个样本都要落在 `[0, length)` 里。
 * - **编辑列表**：只认「没有，或恰好一段且 `media_time ≥ 0`、速率 1」，显示时间扣掉 `media_time`（和 ffmpeg 一致：P9a 对照里 WPE 与
 *   ffmpeg 的帧号一致）；段长不看（不按它截尾）。空编辑（`media_time = -1`）、多段、变速都报原因，等语料里出现再说。
 * - **时长**：`mvhd` 的 `duration / timescale`，和 `containerDuration` 读出的值一致（WPE 的 `GetDuration`，不看编辑列表）；`mvhd`
 *   没有或时长未知 / 为 0 时退到 `mdhd`，再退到 `stts` 的总长。
 * - **失败**：不是 MP4、Matroska、分片 MP4（`moof` / `mvex`）、没有视频轨、编码不是 avc1 / avc3 / hvc1 / hev1、表被截断或互相
 *   对不上、超过上限、`read` 自己 reject：一律返回 `{ error: 中文原因 }`，从不抛错。
 */

/** 按区间读字节（`[start, end)` 相对视频起点），文件区间或 Blob 切片都实现它。 */
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

/** 支持的样本项类型：avc1 / avc3 → H.264，hvc1 / hev1 → H.265。 */
export type VideoSampleEntry = "avc1" | "avc3" | "hvc1" | "hev1";

/** `colr` 盒（`nclx`，或 QuickTime 的 `nclc`）里的色彩标签，码值照 ISO/IEC 23091-2。 */
export interface Mp4Colr {
  primaries: number;
  transfer: number;
  matrix: number;
  /** `nclx` 的 full_range_flag；`nclc` 没有这一位，记 false。 */
  fullRange: boolean;
}

export interface VideoTrackIndex {
  codec: "avc" | "hevc";
  /** 样本项的类型（codec 串的前缀照它）。 */
  sampleEntry: VideoSampleEntry;
  /** avcC / hvcC 盒的内容（不含盒头），即 VideoDecoderConfig.description。 */
  description: Uint8Array;
  /** 视觉样本项里的宽高。 */
  codedWidth: number;
  codedHeight: number;
  /** `mdhd` 的 timescale。 */
  timescale: number;
  /** 容器时长（秒，mvhd，和 containerDuration 一致）。 */
  duration: number;
  /** 每个样本按解码顺序：相对视频起点的字节偏移、长度、显示时间（秒，已扣编辑列表）、是否关键帧（1 / 0）。 */
  offsets: Float64Array;
  sizes: Uint32Array;
  times: Float64Array;
  keys: Uint8Array;
  /** `colr` 盒（nclx / nclc）的标签，没有为 null。 */
  colr: Mp4Colr | null;
  /** 编辑列表扣掉的 `media_time`（mdhd 时间单位），没有编辑列表为 0。 */
  editMediaTime: number;
}

/** 顶层盒子最多看这么多个（同 `container.ts`）：语料最多 5 个，上限只防畸形文件读个不停。 */
export const MAX_TOP_BOXES = 64;
/** `moov` 的上限：语料最大 79 KB（13586，8486 帧），64 MiB 足够几百万帧的表。 */
export const MAX_MOOV_BYTES = 64 * 1024 * 1024;
/** 样本数上限：定长 `stsz` 的样本数不受盒子大小约束，只防畸形值让表分配几 GB。 */
export const MAX_SAMPLES = 10_000_000;

const EBML_HEADER = 0x1a45dfa3;
/** 视觉样本项：盒头 8 + SampleEntry 8 + VisualSampleEntry 70，之后是子盒子（avcC / hvcC / colr / pasp / btrt …）。 */
const VISUAL_SAMPLE_ENTRY_HEADER = 8 + 78;
/** avcC 至少到 numOfSequenceParameterSets；hvcC 定长部分 23 字节。 */
const MIN_AVCC = 7;
const MIN_HVCC = 23;

const SAMPLE_ENTRIES: Record<VideoSampleEntry, { codec: "avc" | "hevc"; config: string; min: number }> = {
  avc1: { codec: "avc", config: "avcC", min: MIN_AVCC },
  avc3: { codec: "avc", config: "avcC", min: MIN_AVCC },
  hvc1: { codec: "hevc", config: "hvcC", min: MIN_HVCC },
  hev1: { codec: "hevc", config: "hvcC", min: MIN_HVCC },
};

/** 内部失败：`indexMp4` 统一接住变成 `{ error }`。 */
class Mp4Error extends Error {}

function fail(message: string): never {
  throw new Mp4Error(message);
}

/**
 * 读顶层盒找到 moov（不读 mdat），解析第一条视频轨；不是 MP4、没有视频轨、编码不是 avc1/avc3/hvc1/hev1 时返回带原因的失败。
 * `length` 是视频数据总长。从不抛错（`read` reject 也一样）。
 */
export async function indexMp4(read: ReadRange, length: number): Promise<VideoTrackIndex | { error: string }> {
  try {
    if (!Number.isSafeInteger(length) || length < 8) return { error: `视频数据太短（${length} 字节）` };
    const moov = await readMoov(read, length);
    return parseMoov(moov, length);
  } catch (error) {
    if (error instanceof Mp4Error) return { error: error.message };
    return { error: `读取或解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

// ———— 读字节 ————

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 读 `[start, end)`，字节数不足（文件被截断、区间越过实际内容）时失败。 */
async function exact(read: ReadRange, start: number, end: number): Promise<Uint8Array> {
  const bytes = await read(start, end);
  if (bytes.length !== end - start) fail(`读取被截断：[${start}, ${end}) 只拿到 ${bytes.length} 字节`);
  return bytes;
}

// ———— 盒子 ————

interface Box {
  type: string;
  /** 盒子起点（头的第一个字节）。 */
  start: number;
  /** 内容起点（头之后）。 */
  content: number;
  end: number;
}

/**
 * `bytes` 里 `at` 处的盒子头（`base` 是 `bytes[0]` 在坐标系里的位置，`limit` 是外层的终点，都按坐标系算）：
 * 32 位大小 + 4 字节类型；大小 1 时后跟 64 位 largesize，0 表示到 `limit` 为止。类型不是可打印 ASCII、大小小于头、
 * 越过 `limit` 时 null。
 */
function boxAt(bytes: Uint8Array, at: number, base: number, limit: number): Box | null {
  const i = at - base;
  if (i < 0 || i + 8 > bytes.length) return null;
  for (let k = 4; k < 8; k++) if (bytes[i + k] < 0x20 || bytes[i + k] > 0x7e) return null;
  const data = view(bytes);
  const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
  const size32 = data.getUint32(i);
  let size: number, headerLength: number;
  if (size32 === 1) {
    if (i + 16 > bytes.length) return null;
    const large = data.getBigUint64(i + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerLength = 16;
  } else {
    size = size32 === 0 ? limit - at : size32;
    headerLength = 8;
  }
  if (size < headerLength || at + size > limit) return null;
  return { type, start: at, content: at + headerLength, end: at + size };
}

/** 顶层逐个只读盒子头，找到 `moov` 再整个读进来（返回的字节从 moov 的盒头开始）。 */
async function readMoov(read: ReadRange, length: number): Promise<Uint8Array> {
  let at = 0;
  for (let n = 0; ; n++) {
    if (at >= length) fail("没有找到 moov 盒子");
    if (n >= MAX_TOP_BOXES) fail(`顶层盒子超过 ${MAX_TOP_BOXES} 个仍没有 moov`);
    const header = await exact(read, at, Math.min(length, at + 16));
    if (n === 0 && header.length >= 4 && view(header).getUint32(0) === EBML_HEADER) {
      fail("是 Matroska / WebM，不是 MP4");
    }
    const box = boxAt(header, at, at, length);
    if (!box) fail(n === 0 ? "不是 MP4：第一个盒子头不认识" : `顶层盒子头畸形或越界（偏移 ${at}）`);
    if (box.type === "moof") fail("分片 MP4（moof）不支持");
    if (box.type === "moov") {
      if (box.end - box.start > MAX_MOOV_BYTES)
        fail(`moov 太大（${box.end - box.start} 字节，上限 ${MAX_MOOV_BYTES}）`);
      return exact(read, box.start, box.end);
    }
    at = box.end;
  }
}

/** `[start, end)` 里一串相邻的子盒子（内存里），畸形时失败。 */
function children(bytes: Uint8Array, start: number, end: number, where: string): Box[] {
  const out: Box[] = [];
  for (let at = start; at < end;) {
    // 不足一个盒头的尾巴（有的封装器在容器末尾补 4 字节 0）：忽略
    if (end - at < 8) break;
    const box = boxAt(bytes, at, 0, end);
    if (!box) fail(`${where} 里的盒子畸形或越界（偏移 ${at}）`);
    out.push(box);
    at = box.end;
  }
  return out;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return children(bytes, parent.content, parent.end, parent.type).find((box) => box.type === type) ?? null;
}

function need(bytes: Uint8Array, parent: Box, type: string): Box {
  return child(bytes, parent, type) ?? fail(`${parent.type} 里缺少 ${type} 盒子`);
}

/** full box：version(1) + flags(3) 之后至少还有 `min` 字节，否则失败。 */
function fullBox(box: Box, min: number): void {
  if (box.end - box.content < 4 + min) fail(`${box.type} 太短`);
}

// ———— moov ————

function parseMoov(moov: Uint8Array, length: number): VideoTrackIndex {
  const top = boxAt(moov, 0, 0, moov.length);
  if (!top) fail("moov 盒子头畸形");
  const kids = children(moov, top.content, top.end, "moov");
  if (kids.some((box) => box.type === "mvex")) fail("分片 MP4（moov 里有 mvex）不支持");
  const mvhd = kids.find((box) => box.type === "mvhd");
  const movieSeconds = mvhd ? movieDuration(moov, mvhd) : undefined;
  for (const trak of kids) {
    if (trak.type !== "trak") continue;
    const mdia = child(moov, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(moov, mdia, "hdlr");
    // hdlr：version/flags(4) pre_defined(4) handler_type(4)
    if (!hdlr || hdlr.end - hdlr.content < 12) continue;
    const at = hdlr.content + 8;
    if (String.fromCharCode(moov[at], moov[at + 1], moov[at + 2], moov[at + 3]) !== "vide") continue;
    return parseVideoTrak(moov, trak, mdia, length, movieSeconds);
  }
  fail("没有视频轨（hdlr 为 vide 的 trak）");
}

/** `mvhd` 的时长（秒），规则同 `containerDuration`：时长全 1（未知）、为 0、timescale 为 0、版本不认识或太短时 undefined。 */
function movieDuration(bytes: Uint8Array, box: Box): number | undefined {
  const scaled = timescaleAndDuration(bytes, box);
  if (!scaled || scaled.timescale === 0 || scaled.duration === undefined || scaled.duration === 0) return undefined;
  return scaled.duration / scaled.timescale;
}

/**
 * `mvhd` / `mdhd` 的 timescale 与 duration：v0 = creation(4) modification(4) timescale(4) duration(4)，v1 = creation(8)
 * modification(8) timescale(4) duration(8)。时长全 1（未知）时 duration 为 undefined；版本不认识或太短时 null。
 */
function timescaleAndDuration(bytes: Uint8Array, box: Box): { timescale: number; duration?: number } | null {
  const data = view(bytes);
  const size = box.end - box.content;
  const version = bytes[box.content];
  if (version === 0 && size >= 20) {
    const value = data.getUint32(box.content + 16);
    return { timescale: data.getUint32(box.content + 12), duration: value === 0xffffffff ? undefined : value };
  }
  if (version === 1 && size >= 32) {
    const value = data.getBigUint64(box.content + 24);
    return {
      timescale: data.getUint32(box.content + 20),
      duration: value === 0xffffffffffffffffn || value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value),
    };
  }
  return null;
}

function parseVideoTrak(
  bytes: Uint8Array,
  trak: Box,
  mdia: Box,
  length: number,
  movieSeconds: number | undefined,
): VideoTrackIndex {
  const data = view(bytes);
  const mdhd = need(bytes, mdia, "mdhd");
  const media = timescaleAndDuration(bytes, mdhd) ?? fail("mdhd 版本不认识或太短");
  const timescale = media.timescale;
  if (timescale === 0) fail("mdhd 的 timescale 为 0");
  const stbl = need(bytes, need(bytes, mdia, "minf"), "stbl");

  // —— 样本项 ——
  const stsd = need(bytes, stbl, "stsd");
  fullBox(stsd, 4);
  if (data.getUint32(stsd.content + 4) < 1) fail("stsd 没有样本项");
  const entry = boxAt(bytes, stsd.content + 8, 0, stsd.end) ?? fail("stsd 的样本项畸形或越界");
  const kind = SAMPLE_ENTRIES[entry.type as VideoSampleEntry];
  if (!kind) fail(`视频编码 ${entry.type} 不支持（只支持 avc1 / avc3 / hvc1 / hev1）`);
  const sampleEntry = entry.type as VideoSampleEntry;
  if (entry.end - entry.start < VISUAL_SAMPLE_ENTRY_HEADER) fail(`${entry.type} 样本项太短`);
  // SampleEntry：reserved(6) data_reference_index(2)；VisualSampleEntry：pre_defined(2) reserved(2) pre_defined(12) width(2) height(2)
  const codedWidth = data.getUint16(entry.start + 32);
  const codedHeight = data.getUint16(entry.start + 34);
  let description: Uint8Array | null = null;
  let colr: Mp4Colr | null = null;
  for (const box of children(bytes, entry.start + VISUAL_SAMPLE_ENTRY_HEADER, entry.end, entry.type)) {
    if (box.type === kind.config && !description) description = bytes.slice(box.content, box.end);
    else if (box.type === "colr" && !colr) colr = parseColr(bytes, box);
  }
  if (!description) fail(`${entry.type} 样本项里缺少 ${kind.config}`);
  if (description.length < kind.min) fail(`${kind.config} 太短（${description.length} 字节）`);

  // —— 样本大小 ——
  if (child(bytes, stbl, "stz2")) fail("stz2（紧凑样本大小表）不支持");
  const stsz = need(bytes, stbl, "stsz");
  fullBox(stsz, 8);
  const fixedSize = data.getUint32(stsz.content + 4);
  const count = data.getUint32(stsz.content + 8);
  if (count === 0) fail("视频轨没有样本");
  if (count > MAX_SAMPLES) fail(`样本数 ${count} 超过上限 ${MAX_SAMPLES}`);
  const sizes = new Uint32Array(count);
  if (fixedSize !== 0) sizes.fill(fixedSize);
  else {
    table(stsz, 12, count, 4);
    for (let i = 0; i < count; i++) sizes[i] = data.getUint32(stsz.content + 12 + 4 * i);
  }

  // —— 偏移：stsc 把样本分到块里，stco / co64 给块的偏移 ——
  const stco = child(bytes, stbl, "stco");
  const co64 = stco ? null : child(bytes, stbl, "co64");
  const chunkBox = stco ?? co64 ?? fail("stbl 里缺少 stco / co64 盒子");
  fullBox(chunkBox, 4);
  const chunks = data.getUint32(chunkBox.content + 4);
  table(chunkBox, 8, chunks, co64 ? 8 : 4);
  const chunkOffset = (index: number): number => {
    if (!co64) return data.getUint32(chunkBox.content + 8 + 4 * index);
    const value = data.getBigUint64(chunkBox.content + 8 + 8 * index);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`co64 第 ${index + 1} 块的偏移过大`);
    return Number(value);
  };
  const stsc = need(bytes, stbl, "stsc");
  fullBox(stsc, 4);
  const runs = data.getUint32(stsc.content + 4);
  table(stsc, 8, runs, 12);
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let k = 0; k < runs; k++) {
    const row = stsc.content + 8 + 12 * k;
    const first = data.getUint32(row) - 1;
    const perChunk = data.getUint32(row + 4);
    if (data.getUint32(row + 8) !== 1) fail("stsc 引用了第 1 个以外的样本项（多个样本项不支持）");
    if (k === 0 ? first !== 0 : first <= data.getUint32(row - 12) - 1) fail(`stsc 第 ${k + 1} 行的 first_chunk 不对`);
    const next = k + 1 < runs ? data.getUint32(row + 12) - 1 : chunks;
    if (next > chunks) fail(`stsc 引用的块超过 ${chunkBox.type} 的 ${chunks} 块`);
    if (perChunk === 0) fail(`stsc 第 ${k + 1} 行每块 0 个样本`);
    for (let c = first; c < next; c++) {
      let at = chunkOffset(c);
      for (let j = 0; j < perChunk; j++, sample++) {
        if (sample >= count) fail(`stsc 分出的样本多于 stsz 的 ${count} 个`);
        offsets[sample] = at;
        at += sizes[sample];
      }
    }
  }
  if (sample !== count) fail(`stsc 只分出 ${sample} 个样本，stsz 有 ${count} 个`);
  for (let i = 0; i < count; i++) {
    if (offsets[i] + sizes[i] > length) fail(`第 ${i + 1} 个样本越过视频数据末尾`);
  }

  // —— 解码时间 stts + 显示偏移 ctts ——
  const stts = need(bytes, stbl, "stts");
  fullBox(stts, 4);
  const sttsRows = data.getUint32(stts.content + 4);
  table(stts, 8, sttsRows, 8);
  const decode = new Float64Array(count);
  let filled = 0;
  let clock = 0;
  for (let k = 0; k < sttsRows; k++) {
    const rowCount = data.getUint32(stts.content + 8 + 8 * k);
    const delta = data.getUint32(stts.content + 12 + 8 * k);
    if (rowCount > count - filled) fail(`stts 的样本数多于 stsz 的 ${count} 个`);
    for (let j = 0; j < rowCount; j++) {
      decode[filled++] = clock;
      clock += delta;
    }
  }
  if (filled !== count) fail(`stts 只覆盖 ${filled} 个样本，stsz 有 ${count} 个`);
  const ctts = child(bytes, stbl, "ctts");
  if (ctts) {
    fullBox(ctts, 4);
    const signed = bytes[ctts.content] === 1;
    const rows = data.getUint32(ctts.content + 4);
    table(ctts, 8, rows, 8);
    filled = 0;
    for (let k = 0; k < rows; k++) {
      const rowCount = data.getUint32(ctts.content + 8 + 8 * k);
      // v0 无符号、v1 有符号（ISO/IEC 14496-12 8.6.1.3）
      const offset = signed ? data.getInt32(ctts.content + 12 + 8 * k) : data.getUint32(ctts.content + 12 + 8 * k);
      if (rowCount > count - filled) fail(`ctts 的样本数多于 stsz 的 ${count} 个`);
      for (let j = 0; j < rowCount; j++) decode[filled++] += offset;
    }
    if (filled !== count) fail(`ctts 只覆盖 ${filled} 个样本，stsz 有 ${count} 个`);
  }

  // —— 编辑列表 ——
  const editMediaTime = parseEdits(bytes, trak);
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = (decode[i] - editMediaTime) / timescale;

  // —— 关键帧 ——
  const keys = new Uint8Array(count);
  const stss = child(bytes, stbl, "stss");
  if (!stss) keys.fill(1);
  else {
    fullBox(stss, 4);
    const rows = data.getUint32(stss.content + 4);
    table(stss, 8, rows, 4);
    for (let k = 0; k < rows; k++) {
      const number = data.getUint32(stss.content + 8 + 4 * k);
      if (number < 1 || number > count) fail(`stss 的样本号 ${number} 越界`);
      keys[number - 1] = 1;
    }
  }

  const duration =
    movieSeconds ??
    (media.duration !== undefined && media.duration > 0 ? media.duration / timescale : undefined) ??
    clock / timescale;
  return {
    codec: kind.codec,
    sampleEntry,
    description,
    codedWidth,
    codedHeight,
    timescale,
    duration,
    offsets,
    sizes,
    times,
    keys,
    colr,
    editMediaTime,
  };
}

/** 表的行从 `box.content + from` 开始，`rows` 行、每行 `stride` 字节，越过盒子时失败。 */
function table(box: Box, from: number, rows: number, stride: number): void {
  if (box.content + from + rows * stride > box.end) fail(`${box.type} 表被截断（${rows} 行）`);
}

/** `colr`：colour_type 之后，nclx = primaries(2) transfer(2) matrix(2) full_range(1 位)；nclc 没有范围位。ICC 的忽略。 */
function parseColr(bytes: Uint8Array, box: Box): Mp4Colr | null {
  const size = box.end - box.content;
  if (size < 4) return null;
  const kind = String.fromCharCode(
    bytes[box.content],
    bytes[box.content + 1],
    bytes[box.content + 2],
    bytes[box.content + 3],
  );
  const data = view(bytes);
  const at = box.content + 4;
  if (kind === "nclx" && size >= 11) {
    return {
      primaries: data.getUint16(at),
      transfer: data.getUint16(at + 2),
      matrix: data.getUint16(at + 4),
      fullRange: (bytes[at + 6] & 0x80) !== 0,
    };
  }
  if (kind === "nclc" && size >= 10) {
    return {
      primaries: data.getUint16(at),
      transfer: data.getUint16(at + 2),
      matrix: data.getUint16(at + 4),
      fullRange: false,
    };
  }
  return null;
}

/**
 * `edts/elst`：没有或 0 段时 0；恰好一段且 `media_time ≥ 0`、速率 1 时返回 `media_time`；其它形状失败。
 * 段：v0 = segment_duration(4) media_time(4，有符号) rate(2 + 2)，v1 = segment_duration(8) media_time(8，有符号) rate(2 + 2)。
 */
function parseEdits(bytes: Uint8Array, trak: Box): number {
  const edts = child(bytes, trak, "edts");
  const elst = edts && child(bytes, edts, "elst");
  if (!elst) return 0;
  fullBox(elst, 4);
  const data = view(bytes);
  const version = bytes[elst.content];
  if (version > 1) fail(`elst 版本 ${version} 不认识`);
  const rows = data.getUint32(elst.content + 4);
  if (rows === 0) return 0;
  const stride = version === 1 ? 20 : 12;
  table(elst, 8, rows, stride);
  if (rows !== 1) fail(`编辑列表有 ${rows} 段（只支持一段）`);
  const row = elst.content + 8;
  let mediaTime: number;
  if (version === 1) {
    const value = data.getBigInt64(row + 8);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("编辑列表的 media_time 过大");
    mediaTime = Number(value);
  } else mediaTime = data.getInt32(row + 4);
  if (mediaTime < 0) fail("编辑列表只有一段空编辑（media_time = -1）");
  const rateAt = row + stride - 4;
  if (data.getInt16(rateAt) !== 1 || data.getInt16(rateAt + 2) !== 0) fail("编辑列表的速率不是 1");
  return mediaTime;
}
