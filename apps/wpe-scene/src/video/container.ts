/**
 * 视频容器头里的时长（P9b 点 1）：编译期（Worker）读出来，随 bundle 交给主线程，脚本 `init` 里读 `duration` 时同步可用。
 *
 * - **MP4 / MOV（ISO BMFF）**：`moov` 里 `mvhd` 的 `duration / timescale`。这就是 WPE 的 `GetDuration`，不看编辑列表；
 *   Chromium 的 `video.duration` 按各轨编辑之后的长度算，语料 59 段 MP4 里有 21 段要短 22–40 ms，其余有毫秒取整的差
 *   （p9-REPORT「P9b 步骤 0 的补测」→「时长」：3361965869 的原片 WPE 10.005333、Chromium 9.983333）。
 * - **Matroska / WebM（EBML）**：`Segment` 里 `Info` 的 `Duration × TimecodeScale / 1e9`。语料只有 1 段（3816870245），
 *   WPE 对它报什么没有实测，取容器头里写的值。
 *
 * 读法：`read` 的区间相对视频数据开头，顶层盒子、`moov` 的子盒子都只读头（≤ 16 字节），`mdat` 按头里的大小跳过、不读内容
 * （语料 21 段的 `moov` 在 `mdat` 之后，`mdat` 可达数百 MiB）；找到 `mvhd` 再读它的前 32 字节。Matroska 一次读到
 * `Segment` 开头往后 64 KiB，在内存里解析。头不认识、盒子越界、读到的字节数不足、`read` 自己 reject：一律返回 `undefined`，
 * 不抛错，播放器退回元素的时长、视频照常播放。
 */

/** 区间读：`[start, end)` 相对视频数据开头（0 = 视频第一个字节）。 */
export type ContainerRead = (start: number, end: number) => Promise<Uint8Array>;

/** 顶层盒子最多看这么多个：语料最多 5 个（`ftyp moov uuid free mdat`），上限只防畸形文件（一串零长度的小盒子）读个不停。 */
const MAX_TOP_BOXES = 64;
/** `moov` 的子盒子最多看这么多个：`mvhd`、每轨一个 `trak`、`udta` / `meta` / `iods` 等，`mvhd` 通常是第一个。 */
const MAX_MOOV_CHILDREN = 64;
/** Matroska 只在 `Segment` 内容开头这么多字节里找 `Info`（mkvmerge / FFmpeg 都把它写在 `SeekHead` 之后的前几百字节）。 */
const MATROSKA_WINDOW = 64 * 1024;
/** EBML 头（文件开头、`Segment` 之前）的上限，只防畸形大小把一次读放大。 */
const MAX_EBML_HEADER = 4096;

const EBML_HEADER = 0x1a45dfa3;
const MATROSKA_SEGMENT = 0x18538067;
const MATROSKA_INFO = 0x1549a966;
const MATROSKA_TIMECODE_SCALE = 0x2ad7b1;
const MATROSKA_DURATION = 0x4489;
/** `TimecodeScale` 缺省：1 ms（单位纳秒）。 */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

/**
 * 容器头里的时长（秒）：MP4 的 `mvhd`、Matroska 的 `Info.Duration`。`read` 的区间相对视频数据开头，`length` 是视频数据总长。
 * 读不出时 undefined，从不抛错（`read` reject 也一样）。
 */
export async function containerDuration(read: ContainerRead, length: number): Promise<number | undefined> {
  try {
    if (!Number.isSafeInteger(length) || length < 8) return undefined;
    // 头 16 字节同时用来认封装：MP4 的第一个盒子头（含 64 位大小）、Matroska 的 EBML 头 ID 与大小
    const head = await exact(read, 0, Math.min(length, 16));
    const seconds =
      view(head).getUint32(0) === EBML_HEADER
        ? await matroskaDuration(read, length, head)
        : await isoDuration(read, length, head);
    return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    // 读不到、越界、解析出错都当作没有时长：退回元素的时长，不影响播放
    return undefined;
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 读 `[start, end)`，字节数不足（文件被截断、区间越过实际内容）时抛错，由 `containerDuration` 统一吞掉。 */
async function exact(read: ContainerRead, start: number, end: number): Promise<Uint8Array> {
  const bytes = await read(start, end);
  if (bytes.length !== end - start) throw new Error("容器头读取被截断");
  return bytes;
}

// ———— ISO BMFF ————

interface Box {
  type: string;
  /** 内容起点（头之后）。 */
  content: number;
  end: number;
}

/**
 * `at` 处的盒子头：32 位大小 + 4 字节类型；大小 1 时后跟 64 位 largesize，0 表示到 `limit` 为止。
 * 类型不是可打印 ASCII、大小小于头、越过 `limit` 时 null（不认识的头 / 畸形）。`uuid` 盒子的扩展类型不影响跳过，不读。
 */
function boxAt(header: Uint8Array, at: number, limit: number): Box | null {
  if (header.length < 8) return null;
  const data = view(header);
  for (let i = 4; i < 8; i++) if (header[i] < 0x20 || header[i] > 0x7e) return null;
  const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
  const size32 = data.getUint32(0);
  let size: number, headerLength: number;
  if (size32 === 1) {
    if (header.length < 16) return null;
    const large = data.getBigUint64(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerLength = 16;
  } else {
    size = size32 === 0 ? limit - at : size32;
    headerLength = 8;
  }
  if (size < headerLength || at + size > limit) return null;
  return { type, content: at + headerLength, end: at + size };
}

/**
 * 在 `[start, limit)` 里一串相邻的盒子中找第一个 `type`：每个只读头（≤ 16 字节），其余按大小跳过、不读内容。
 * `first` 是 `start` 处已经读到的头（顶层复用认封装时读的 16 字节）。没有、畸形或超过 `max` 个时 null。
 */
async function findBox(
  read: ContainerRead,
  start: number,
  limit: number,
  type: string,
  max: number,
  first?: Uint8Array,
): Promise<Box | null> {
  let at = start;
  for (let n = 0; at < limit && n < max; n++) {
    const header = n === 0 && first ? first : await exact(read, at, Math.min(limit, at + 16));
    const box = boxAt(header, at, limit);
    if (!box) return null;
    if (box.type === type) return box;
    at = box.end;
  }
  return null;
}

async function isoDuration(read: ContainerRead, length: number, head: Uint8Array): Promise<number | undefined> {
  const moov = await findBox(read, 0, length, "moov", MAX_TOP_BOXES, head);
  if (!moov) return undefined;
  // `mvhd` 不一定是 `moov` 的第一个子盒子，同样逐个看头
  const mvhd = await findBox(read, moov.content, moov.end, "mvhd", MAX_MOOV_CHILDREN);
  if (!mvhd) return undefined;
  // full box：version(1) flags(3)，之后 v0 = creation(4) modification(4) timescale(4) duration(4)，
  // v1 = creation(8) modification(8) timescale(4) duration(8)；最多读到 v1 的 duration 末尾（32 字节）
  const { content, end } = mvhd;
  const body = await exact(read, content, Math.min(end, content + 32));
  const data = view(body);
  const version = body[0];
  let timescale: number, duration: number;
  if (version === 0 && body.length >= 20) {
    timescale = data.getUint32(12);
    const value = data.getUint32(16);
    if (value === 0xffffffff) return undefined; // 全 1：时长未知
    duration = value;
  } else if (version === 1 && body.length >= 32) {
    timescale = data.getUint32(20);
    const value = data.getBigUint64(24);
    if (value === 0xffffffffffffffffn) return undefined; // 全 1：时长未知
    duration = Number(value);
  } else return undefined;
  // duration 为 0 时（分片 MP4 把总长写在 `mehd` / 各分片里）同样当作读不出，退回元素的时长，不给脚本一个 0
  if (timescale === 0 || duration === 0) return undefined;
  return duration / timescale;
}

// ———— Matroska / EBML ————

interface Vint {
  value: number;
  length: number;
  /** 大小的值位全为 1：未知长度。 */
  unknown: boolean;
}

/** EBML 元素 ID：首字节前导 0 的个数 + 1 是长度（1–4），保留标记位。越界或长度不合法时 null。 */
function elementId(bytes: Uint8Array, at: number): { value: number; length: number } | null {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  const length = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!length || at + length > bytes.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length };
}

/** EBML 变长大小：长度 1–8，去掉标记位；值位全 1 是未知长度。越界、长度不合法、超过安全整数时 null。 */
function elementSize(bytes: Uint8Array, at: number): Vint | null {
  if (at >= bytes.length) return null;
  const first = bytes[at];
  if (first === 0) return null;
  const length = Math.clz32(first) - 23; // 8 位里的前导 0 个数 + 1
  if (at + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = first & mask;
  let unknown = value === mask;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i];
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  if (!unknown && !Number.isSafeInteger(value)) return null;
  return { value, length, unknown };
}

interface Element {
  id: number;
  content: number;
  /** 内容终点；未知长度时为 `limit`。 */
  end: number;
  unknown: boolean;
}

/** `at` 处的元素头，内容越过 `limit` 时 null。 */
function elementAt(bytes: Uint8Array, at: number, limit: number): Element | null {
  const id = elementId(bytes, at);
  if (!id) return null;
  const size = elementSize(bytes, at + id.length);
  if (!size) return null;
  const content = at + id.length + size.length;
  const end = size.unknown ? limit : content + size.value;
  if (end > limit) return null;
  return { id: id.value, content, end, unknown: size.unknown };
}

async function matroskaDuration(read: ContainerRead, length: number, head: Uint8Array): Promise<number | undefined> {
  // EBML 头的大小在头 16 字节里（ID 4 字节 + 大小最多 8 字节）
  const ebml = elementAt(head, 0, Number.MAX_SAFE_INTEGER);
  // EBML 头只有版本、DocType 等几个小字段（几十字节）；大小离谱时不按它读一大段
  if (!ebml || ebml.unknown || ebml.end > MAX_EBML_HEADER) return undefined;
  // 一次读到 Segment 内容开头往后 64 KiB：Segment 头最多 4 + 8 字节
  const segmentAt = ebml.end;
  const bytes = await exact(read, 0, Math.min(length, segmentAt + 12 + MATROSKA_WINDOW));
  const segment = elementAt(bytes, segmentAt, Number.MAX_SAFE_INTEGER);
  if (!segment || segment.id !== MATROSKA_SEGMENT) return undefined;
  // 未知长度的 Segment（流式写出）按到视频结尾处理
  const segmentEnd = segment.unknown ? length : segment.end;
  if (segmentEnd > length) return undefined;
  // 只看起点落在 Segment 开头 64 KiB 以内的顶层元素；每个元素至少 2 字节，窗口本身就限住了遍历次数
  const windowEnd = Math.min(segment.content + MATROSKA_WINDOW, segmentEnd, bytes.length);
  for (let at = segment.content; at < windowEnd;) {
    const child = elementAt(bytes, at, segmentEnd);
    // 未知长度的子元素（直播流的 Cluster）跳不过去，Info 也不会在它后面
    if (!child || child.unknown) return undefined;
    if (child.id === MATROSKA_INFO) return child.end <= bytes.length ? infoDuration(bytes, child) : undefined;
    at = child.end;
  }
  return undefined;
}

/** `Info` 里的 `TimecodeScale`（无符号整数，缺省 1000000）与 `Duration`（4 / 8 字节大端浮点），秒。 */
function infoDuration(bytes: Uint8Array, info: Element): number | undefined {
  let scale = DEFAULT_TIMECODE_SCALE;
  let duration: number | undefined;
  for (let at = info.content; at < info.end;) {
    const child = elementAt(bytes, at, info.end);
    if (!child || child.unknown) return undefined;
    const size = child.end - child.content;
    if (child.id === MATROSKA_TIMECODE_SCALE) {
      if (size > 8) return undefined;
      scale = 0;
      for (let i = child.content; i < child.end; i++) scale = scale * 256 + bytes[i];
      if (!Number.isSafeInteger(scale)) return undefined;
    } else if (child.id === MATROSKA_DURATION) {
      const data = new DataView(bytes.buffer, bytes.byteOffset + child.content, size);
      if (size === 4) duration = data.getFloat32(0);
      else if (size === 8) duration = data.getFloat64(0);
      else return undefined;
    }
    at = child.end;
  }
  if (duration === undefined || scale === 0) return undefined;
  return (duration * scale) / 1e9;
}
