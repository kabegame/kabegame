/**
 * 容器时长（P9b 点 1）：MP4 的 `mvhd`、Matroska 的 `Info.Duration`。字节全部在这里按规范构造，不依赖语料；
 * 语料 60 段的逐段对照在 `ignore/p9/p9b/step1/`。读法另有断言：`mdat` 只读头、不碰内容，Matroska 两次读。
 */
import { describe, expect, it } from "vitest";
import { containerDuration, type ContainerRead } from "./container";

function concat(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}
function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}
function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ———— ISO BMFF 构造 ————

/** 普通盒子：32 位大小 + 类型 + 内容。 */
function box(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(u32be(8 + body.length), ascii(type), body);
}
/** 64 位大小的盒子：大小字段写 1，类型之后跟 largesize。 */
function largeBox(type: string, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(u32be(1), ascii(type), u64be(BigInt(16 + body.length)), body);
}
/** `mvhd` 在时长之后的 80 字节：rate、volume、保留、矩阵、pre_defined、next_track_ID（这里不读，填 0）。 */
const MVHD_TAIL = new Uint8Array(80);
function mvhd0(timescale: number, duration: number): Uint8Array {
  return box("mvhd", u32be(0), u32be(1), u32be(2), u32be(timescale), u32be(duration), MVHD_TAIL);
}
function mvhd1(timescale: number, duration: bigint): Uint8Array {
  return box("mvhd", u32be(1 << 24), u64be(1n), u64be(2n), u32be(timescale), u64be(duration), MVHD_TAIL);
}
const FTYP = box("ftyp", ascii("isom"), u32be(512), ascii("isomiso2avc1mp41"));
/** 一个占位的 `trak`（只为让 `moov` 里有别的子盒子）。 */
const TRAK = box("trak", box("tkhd", new Uint8Array(84)), box("mdia", box("mdhd", new Uint8Array(24))));

/** 记下每次区间读的替身。 */
function memoryRead(bytes: Uint8Array): { read: ContainerRead; calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    read: async (start, end) => {
      calls.push([start, end]);
      return bytes.slice(start, end);
    },
  };
}

/**
 * 稀疏文件：只有 `parts` 里给出的字节，其余区间（大 `mdat` 的内容）不存在。读到不存在的字节记一次 `touched`，
 * 返回的字节数照样足，只为断言「没读」，不让结果受影响。
 */
function sparseRead(parts: { at: number; bytes: Uint8Array }[]): {
  read: ContainerRead;
  calls: [number, number][];
  touched: [number, number][];
} {
  const calls: [number, number][] = [];
  const touched: [number, number][] = [];
  return {
    calls,
    touched,
    read: async (start, end) => {
      calls.push([start, end]);
      const out = new Uint8Array(end - start);
      for (let i = start; i < end; i++) {
        const part = parts.find(({ at, bytes }) => i >= at && i < at + bytes.length);
        if (part) out[i - start] = part.bytes[i - part.at];
        else {
          touched.push([start, end]);
          break;
        }
      }
      return out;
    },
  };
}

/**
 * 顶层 `ftyp`、大 `mdat`、`moov` 的稀疏文件。`mdatHeader` 是 `mdat` 的头字节，内容 `mdatBody` 字节里只有「头窗口」
 * （从盒子起点算 16 字节：盒子头按 16 字节读，8 字节头的盒子会顺带盖到内容的前 8 字节）存在，再往后的不存在。
 * `untouched` 是不该被读到的区间。
 */
function moovAfterMdat(mdatHeader: Uint8Array, mdatBody: number, moov: Uint8Array) {
  const mdatAt = FTYP.length;
  const moovAt = mdatAt + mdatHeader.length + mdatBody;
  const window = concat(mdatHeader, new Uint8Array(16 - mdatHeader.length));
  const file = sparseRead([
    { at: 0, bytes: FTYP },
    { at: mdatAt, bytes: window },
    { at: moovAt, bytes: moov },
  ]);
  return { ...file, length: moovAt + moov.length, untouched: [mdatAt + 16, moovAt] as const };
}

describe("containerDuration：MP4 的 mvhd（WPE 的 GetDuration，不看编辑列表）", () => {
  it("mvhd v0：duration / timescale；faststart 文件只读 4 次小区间", async () => {
    const bytes = concat(FTYP, box("moov", mvhd0(1000, 2517), TRAK), box("mdat", new Uint8Array(4096)));
    const { read, calls } = memoryRead(bytes);
    expect(await containerDuration(read, bytes.length)).toBe(2517 / 1000);
    // 顶层头（复用认封装那 16 字节）→ moov 头 → mvhd 头 → mvhd 前 32 字节；mdat 一个字节都不碰
    expect(calls).toEqual([
      [0, 16],
      [FTYP.length, FTYP.length + 16],
      [FTYP.length + 8, FTYP.length + 24],
      [FTYP.length + 16, FTYP.length + 48],
    ]);
  });

  it("mvhd v1：64 位 duration（大于 2³²）", async () => {
    const duration = 2n ** 33n + 12345n;
    const bytes = concat(FTYP, box("moov", mvhd1(1_000_000, duration)));
    const { read } = memoryRead(bytes);
    expect(await containerDuration(read, bytes.length)).toBe(Number(duration) / 1_000_000);
  });

  it("3361965869 原片的 mvhd：10.005333（Chromium 按编辑之后是 9.983333）", async () => {
    // p9-REPORT「时长」；mvhd 的 timescale 90000、duration 900480 是原片里的值（ignore/p9/p9b/out/durations.json）
    const bytes = concat(FTYP, box("moov", mvhd0(90000, 900480), TRAK, TRAK));
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBe(900480 / 90000);
  });

  it("mdat 在 moov 之前：按头里的大小跳过，不读内容（300 MiB 的 mdat）", async () => {
    const body = 300 * 1024 * 1024;
    const file = moovAfterMdat(concat(u32be(8 + body), ascii("mdat")), body, box("moov", mvhd0(600, 1510)));
    expect(await containerDuration(file.read, file.length)).toBe(1510 / 600);
    expect(file.touched).toEqual([]);
    const [from, to] = file.untouched;
    for (const [start, end] of file.calls) {
      expect(end <= from || start >= to, `[${start}, ${end}) 读到了 mdat 的内容`).toBe(true);
      expect(end - start).toBeLessThanOrEqual(32);
    }
    // ftyp 头、mdat 头、moov 头、mvhd 头、mvhd 内容
    expect(file.calls).toHaveLength(5);
  });

  it("64 位 largesize：5 GiB 的 mdat 与 largesize 的 moov 都按 16 字节头跳过", async () => {
    const body = 5 * 1024 ** 3;
    const mdatHeader = concat(u32be(1), ascii("mdat"), u64be(BigInt(16 + body)));
    const file = moovAfterMdat(mdatHeader, body, largeBox("moov", mvhd0(30000, 1_801_800)));
    expect(file.length).toBeGreaterThan(2 ** 32);
    expect(await containerDuration(file.read, file.length)).toBe(1_801_800 / 30000);
    expect(file.touched).toEqual([]);
  });

  it("moov 里 mvhd 不是第一个子盒子：前面的子盒子只读头", async () => {
    const before = [box("iods", new Uint8Array(16)), box("udta", box("meta", new Uint8Array(200))), TRAK];
    const bytes = concat(FTYP, box("moov", ...before, mvhd0(1000, 60000)));
    const { read, calls } = memoryRead(bytes);
    expect(await containerDuration(read, bytes.length)).toBe(60);
    expect(calls.every(([start, end]) => end - start <= 32)).toBe(true);
    // 顶层 2 个头 + moov 里 4 个子盒子头 + mvhd 内容
    expect(calls).toHaveLength(7);
  });

  it("最后一个盒子大小写 0：到结尾为止", async () => {
    const moov = box("moov", mvhd0(1000, 4000));
    moov.set(u32be(0), 0);
    const bytes = concat(FTYP, moov);
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBe(4);
  });

  it.each([
    ["timescale 为 0", concat(FTYP, box("moov", mvhd0(0, 2517)))],
    ["v0 duration 全 1（未知）", concat(FTYP, box("moov", mvhd0(1000, 0xffffffff)))],
    ["v1 duration 全 1（未知）", concat(FTYP, box("moov", mvhd1(1000, 0xffffffffffffffffn)))],
    ["duration 为 0（分片 MP4）", concat(FTYP, box("moov", mvhd0(1000, 0)))],
    ["没有 moov", concat(FTYP, box("free", new Uint8Array(8)), box("mdat", new Uint8Array(64)))],
    ["moov 里没有 mvhd", concat(FTYP, box("moov", TRAK))],
    ["mvhd 版本 2", concat(FTYP, box("moov", box("mvhd", u32be(2 << 24), new Uint8Array(96))))],
    ["mvhd 太短", concat(FTYP, box("moov", box("mvhd", u32be(0), u32be(1), u32be(2), u32be(1000))))],
  ])("%s → undefined", async (_, bytes) => {
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBeUndefined();
  });

  it("截断：盒子越过总长、moov 越界、读到的字节数不足 → undefined", async () => {
    const whole = concat(FTYP, box("moov", mvhd0(1000, 2517), TRAK));
    // 总长说短了：moov 的大小越过 length
    expect(await containerDuration(memoryRead(whole).read, whole.length - 1)).toBeUndefined();
    // 文件实际比 length 短：读 mvhd 时拿到的字节不够
    const cut = whole.slice(0, FTYP.length + 30);
    expect(await containerDuration(memoryRead(cut).read, whole.length)).toBeUndefined();
    // 子盒子越过 moov
    const bad = concat(FTYP, box("moov", concat(u32be(4096), ascii("trak"))), box("mdat", new Uint8Array(8192)));
    expect(await containerDuration(memoryRead(bad).read, bad.length)).toBeUndefined();
    // 大小小于头
    const tiny = concat(u32be(4), ascii("ftyp"), box("moov", mvhd0(1000, 1)));
    expect(await containerDuration(memoryRead(tiny).read, tiny.length)).toBeUndefined();
  });

  it("不认识的头 → undefined：类型不是可打印 ASCII、RIFF、太短", async () => {
    const garbage = new Uint8Array(4096).map((_, i) => (i * 37 + 11) & 255);
    expect(await containerDuration(memoryRead(garbage).read, garbage.length)).toBeUndefined();
    const riff = concat(ascii("RIFF"), new Uint8Array([0x10, 0, 0, 0]), ascii("AVI LIST"), new Uint8Array(32));
    expect(await containerDuration(memoryRead(riff).read, riff.length)).toBeUndefined();
    expect(await containerDuration(memoryRead(FTYP).read, 7)).toBeUndefined();
    expect(await containerDuration(memoryRead(FTYP).read, Number.NaN)).toBeUndefined();
  });

  it("read 自己 reject 或同步抛错 → undefined，不抛", async () => {
    await expect(containerDuration(() => Promise.reject(new TypeError("Failed to fetch")), 4096)).resolves.toBe(
      undefined,
    );
    await expect(
      containerDuration(() => {
        throw new Error("boom");
      }, 4096),
    ).resolves.toBe(undefined);
    // 读到一半才失败（mvhd 内容那次）
    const bytes = concat(FTYP, box("moov", mvhd0(1000, 2517)));
    let n = 0;
    const flaky: ContainerRead = async (start, end) => {
      if (++n === 4) throw new TypeError("Failed to fetch");
      return bytes.slice(start, end);
    };
    expect(await containerDuration(flaky, bytes.length)).toBeUndefined();
  });

  it("一串零长度的小盒子：最多看 64 个就放弃", async () => {
    const bytes = concat(...Array.from({ length: 200 }, () => box("free")), box("moov", mvhd0(1000, 1000)));
    const { read, calls } = memoryRead(bytes);
    expect(await containerDuration(read, bytes.length)).toBeUndefined();
    expect(calls.length).toBeLessThanOrEqual(64);
  });
});

// ———— Matroska / EBML 构造 ————

/** 元素 ID 的字节（ID 本身带长度标记位，按数值大小取 1–4 字节）。 */
function ebmlId(id: number): Uint8Array {
  const length = id < 0x100 ? 1 : id < 0x10000 ? 2 : id < 0x1000000 ? 3 : 4;
  return u32be(id).slice(4 - length);
}
/** 变长大小：缺省取最短编码，`width` 指定字节数（mkvmerge 常把 Segment 大小写成 8 字节）。 */
function ebmlSize(value: number, width?: number): Uint8Array {
  let length = width ?? 1;
  while (!width && value >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}
/** 未知长度（值位全 1），8 字节。 */
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
function el(id: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(ebmlId(id), ebmlSize(body.length), body);
}
function uint(value: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return new Uint8Array(bytes.length ? bytes : [0]);
}
function f32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value);
  return out;
}
function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  void: 0xec,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  muxingApp: 0x4d80,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
};
const EBML_HEAD = el(
  ID.ebml,
  el(0x4286, uint(1)),
  el(0x42f7, uint(1)),
  el(0x42f2, uint(4)),
  el(0x42f3, uint(8)),
  el(0x4282, ascii("matroska")),
  el(0x4287, uint(4)),
  el(0x4285, uint(2)),
);
const SEEK_HEAD = el(ID.seekHead, new Uint8Array(40));

/** EBML 头 + Segment（大小 8 字节，或未知长度）。 */
function matroska(children: Uint8Array[], options: { unknownSize?: boolean } = {}): Uint8Array {
  const body = concat(...children);
  return concat(EBML_HEAD, ebmlId(ID.segment), options.unknownSize ? UNKNOWN_SIZE : ebmlSize(body.length, 8), body);
}
function info(...fields: Uint8Array[]): Uint8Array {
  return el(ID.info, ...fields, el(ID.muxingApp, ascii("Lavf61.7.100")));
}
const CLUSTER = el(ID.cluster, new Uint8Array(2048));

describe("containerDuration：Matroska 的 Info.Duration × TimecodeScale / 1e9", () => {
  it("TimecodeScale 缺省（1 ms）+ 8 字节 Duration：3816870245 的 58793 → 58.793；两次读", async () => {
    const bytes = matroska([SEEK_HEAD, info(el(ID.duration, f64(58793))), el(ID.tracks, new Uint8Array(64)), CLUSTER]);
    const { read, calls } = memoryRead(bytes);
    expect(await containerDuration(read, bytes.length)).toBe((58793 * 1_000_000) / 1e9);
    // 认封装的 16 字节、到 Segment 开头往后 64 KiB（文件更短时到结尾）
    expect(calls).toEqual([
      [0, 16],
      [0, bytes.length],
    ]);
  });

  it("TimecodeScale 给出 + 4 字节 Duration", async () => {
    const bytes = matroska([info(el(ID.timecodeScale, uint(100_000)), el(ID.duration, f32(123456.5))), CLUSTER]);
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBe((123456.5 * 100_000) / 1e9);
  });

  it("Segment 未知长度：按到结尾处理", async () => {
    const bytes = matroska([SEEK_HEAD, info(el(ID.duration, f64(2517))), CLUSTER], { unknownSize: true });
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBe(2.517);
  });

  it("只在 Segment 开头 64 KiB 里找 Info：前面垫 60 000 字节能找到，70 000 字节找不到", async () => {
    const pad = (n: number) => el(ID.void, new Uint8Array(n));
    const near = matroska([SEEK_HEAD, pad(60_000), info(el(ID.duration, f64(1000))), CLUSTER]);
    expect(await containerDuration(memoryRead(near).read, near.length)).toBe(1);
    const far = matroska([SEEK_HEAD, pad(70_000), info(el(ID.duration, f64(1000))), CLUSTER]);
    const { read, calls } = memoryRead(far);
    expect(await containerDuration(read, far.length)).toBeUndefined();
    // 第二次读停在 Segment 开头往后 64 KiB（+ Segment 头 12 字节），不跟着文件变大
    expect(calls[1][1]).toBe(EBML_HEAD.length + 12 + 64 * 1024);
  });

  it.each([
    ["没有 Duration", matroska([info(el(ID.timecodeScale, uint(1_000_000))), CLUSTER])],
    ["Duration 不是 4 / 8 字节", matroska([info(el(ID.duration, new Uint8Array(2))), CLUSTER])],
    ["TimecodeScale 为 0", matroska([info(el(ID.timecodeScale, uint(0)), el(ID.duration, f64(10))), CLUSTER])],
    ["没有 Info", matroska([SEEK_HEAD, CLUSTER])],
    ["EBML 头之后不是 Segment", concat(EBML_HEAD, el(ID.cluster, info(el(ID.duration, f64(10)))))],
    ["未知长度的 Cluster 在 Info 之前", matroska([concat(ebmlId(ID.cluster), UNKNOWN_SIZE, new Uint8Array(64))])],
  ])("%s → undefined", async (_, bytes) => {
    expect(await containerDuration(memoryRead(bytes).read, bytes.length)).toBeUndefined();
  });

  it("截断：Segment 大小越过总长 → undefined", async () => {
    const bytes = matroska([info(el(ID.duration, f64(1000))), CLUSTER]);
    expect(await containerDuration(memoryRead(bytes).read, bytes.length - 1)).toBeUndefined();
    // 文件实际比 length 短
    expect(await containerDuration(memoryRead(bytes.slice(0, 60)).read, bytes.length)).toBeUndefined();
  });

  it("EBML 头大小离谱：不按它读一大段", async () => {
    const bytes = concat(ebmlId(ID.ebml), ebmlSize(100 * 1024 * 1024, 8), new Uint8Array(64));
    const { read, calls } = memoryRead(bytes);
    expect(await containerDuration(read, 200 * 1024 * 1024)).toBeUndefined();
    expect(calls).toEqual([[0, 16]]);
  });
});
