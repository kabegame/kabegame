/**
 * MP4 帧表（P9d 步骤 1 点 1）：字节全部按 ISO/IEC 14496-12 拼出来（构造工具在 `testMp4.ts`，`codecPlayer.test.ts` 也用），不依赖语料；语料 60 段的逐段对照在
 * `ignore/p9/p9d/step1/corpus.ts`。读法另有断言：`mdat` 只读头、不碰内容。
 */
import { describe, expect, it } from "vitest";
import { indexMp4, MAX_MOOV_BYTES, MAX_SAMPLES, MAX_TOP_BOXES, type ReadRange, type VideoTrackIndex } from "./mp4";
import {
  ascii,
  AVCC,
  box,
  buildMp4,
  colrNclx,
  concat,
  type EditRow,
  FTYP,
  full,
  hdlr,
  HVCC,
  mdhd,
  memoryRead,
  moovOf,
  mvhd,
  type Spec,
  u16be,
  u32be,
  u64be,
} from "./testMp4";

async function index(bytes: Uint8Array, length = bytes.length): Promise<VideoTrackIndex> {
  const result = await indexMp4(memoryRead(bytes).read, length);
  if ("error" in result) throw new Error(`意外失败：${result.error}`);
  return result;
}

async function failure(bytes: Uint8Array, length = bytes.length): Promise<string> {
  const result = await indexMp4(memoryRead(bytes).read, length);
  if (!("error" in result)) throw new Error("意外成功");
  return result.error;
}

/** 每个样本按偏移、长度切出来，和拼的时候一致。 */
function expectSamples(track: VideoTrackIndex, bytes: Uint8Array, samples: Uint8Array[]): void {
  expect(track.sizes.length).toBe(samples.length);
  samples.forEach((expected, i) => {
    expect(bytes.slice(track.offsets[i], track.offsets[i] + track.sizes[i]), `样本 ${i + 1}`).toEqual(expected);
  });
}

const BASIC: Spec = {
  sizes: [40, 13, 7, 29, 5],
  perChunk: [2, 2, 1],
  stts: [[5, 512]],
  stss: [1, 4],
};

describe("indexMp4：样本表", () => {
  it("基本：stsz / stsc（两行）/ stco / stts / stss，样本偏移切得出原内容", async () => {
    const { bytes, samples } = buildMp4(BASIC);
    const track = await index(bytes);
    expect(track.codec).toBe("avc");
    expect(track.sampleEntry).toBe("avc1");
    expect(track.description).toEqual(AVCC);
    expect([track.codedWidth, track.codedHeight]).toEqual([1920, 1080]);
    expect(track.timescale).toBe(15360);
    expect(track.duration).toBe(2);
    expect(track.colr).toBeNull();
    expect(track.editMediaTime).toBe(0);
    expectSamples(track, bytes, samples);
    expect(Array.from(track.times)).toEqual([0, 1, 2, 3, 4].map((i) => (i * 512) / 15360));
    expect(Array.from(track.keys)).toEqual([1, 0, 0, 1, 0]);
  });

  it("stsz 定长写法：全部样本同样大", async () => {
    const { bytes, samples } = buildMp4({ ...BASIC, sizes: [9, 9, 9, 9, 9], fixedSize: true });
    expectSamples(await index(bytes), bytes, samples);
  });

  it("stsc 多行、每块样本数不同、块之间夹着别的数据", async () => {
    const spec: Spec = { ...BASIC, sizes: [3, 4, 5, 6, 7, 8, 9], perChunk: [3, 1, 1, 2], stts: [[7, 1000]], gap: 11 };
    const { bytes, samples } = buildMp4(spec);
    expectSamples(await index(bytes), bytes, samples);
  });

  it("mdat 在 moov 之前：只读 mdat 的头、不碰内容", async () => {
    const { bytes, samples, mdatContent } = buildMp4({ ...BASIC, mdatFirst: true, sizes: [400, 300, 200, 100, 50] });
    const { read, calls } = memoryRead(bytes);
    const track = await indexMp4(read, bytes.length);
    if ("error" in track) throw new Error(track.error);
    expectSamples(track, bytes, samples);
    // 盒头按 16 字节读，8 字节头的 mdat 会顺带盖到内容的前 8 字节；再往后一个字节都不读
    for (const [start, end] of calls) {
      expect(end <= mdatContent[0] + 8 || start >= mdatContent[1], `[${start}, ${end}) 读到了 mdat 的内容`).toBe(true);
    }
    // ftyp 头、mdat 头、moov 头、整个 moov
    expect(calls).toHaveLength(4);
  });

  it("co64：5 GiB 之后的块偏移按 64 位读", async () => {
    // 只有 ftyp + moov 是真字节，mdat 是 largesize 的虚拟盒子；偏移指到 2³² 之后
    const big = 5 * 1024 ** 3;
    const spec: Spec = { ...BASIC, co64: true };
    const chunkStarts = [big, big + 53, big + 1000];
    const moov = moovOf(spec, chunkStarts);
    const head = concat(FTYP, moov, u32be(1), ascii("mdat"), u64be(BigInt(big + 2000)));
    const length = FTYP.length + moov.length + big + 2000;
    const read: ReadRange = async (start, end) => {
      const out = new Uint8Array(end - start);
      out.set(head.subarray(Math.min(start, head.length), Math.min(end, head.length)));
      return out;
    };
    const track = await indexMp4(read, length);
    if ("error" in track) throw new Error(track.error);
    expect(Array.from(track.offsets)).toEqual([big, big + 40, big + 53, big + 53 + 7, big + 1000]);
  });

  it("缺 stss：全部是关键帧", async () => {
    const { bytes } = buildMp4({ ...BASIC, stss: null });
    expect(Array.from((await index(bytes)).keys)).toEqual([1, 1, 1, 1, 1]);
  });

  it("stts 多行：解码时间逐行累加", async () => {
    const { bytes } = buildMp4({
      ...BASIC,
      timescale: 600,
      stts: [
        [2, 20],
        [3, 25],
      ],
    });
    expect(Array.from((await index(bytes)).times)).toEqual([0, 20, 40, 65, 90].map((t) => t / 600));
  });
});

describe("indexMp4：显示时间（ctts 与编辑列表）", () => {
  // I P B B P：解码 0 1 2 3 4，显示 0 3 1 2 4（delta 512）
  const B_FRAMES: Spec = {
    sizes: [10, 10, 10, 10, 10],
    perChunk: [5],
    stts: [[5, 512]],
  };

  it("ctts v0 + 单段编辑列表：显示时间 = (dts + ctts − media_time) / timescale", async () => {
    const { bytes } = buildMp4({
      ...B_FRAMES,
      ctts: {
        version: 0,
        rows: [
          [1, 1024],
          [1, 2560],
          [2, 512],
          [1, 1024],
        ],
      },
      elst: { version: 0, rows: [[2000, 1024]] },
    });
    const track = await index(bytes);
    expect(track.editMediaTime).toBe(1024);
    // dts 0 512 1024 1536 2048 + ctts 1024 2560 512 512 1024 − 1024
    expect(Array.from(track.times)).toEqual([0, 2048, 512, 1024, 2048].map((t) => t / 15360));
  });

  it("ctts v1：偏移有符号（负偏移），不用编辑列表", async () => {
    const { bytes } = buildMp4({
      ...B_FRAMES,
      ctts: {
        version: 1,
        rows: [
          [1, 0],
          [1, 1536],
          [2, -512],
          [1, 0],
        ],
      },
    });
    expect(Array.from((await index(bytes)).times)).toEqual([0, 2048, 512, 1024, 2048].map((t) => t / 15360));
  });

  it("ctts v0：偏移无符号（高位为 1 时是大正数，不当负数）", async () => {
    const { bytes } = buildMp4({
      ...B_FRAMES,
      sizes: [10],
      perChunk: [1],
      stts: [[1, 512]],
      ctts: { version: 0, rows: [[1, 0x80000000]] },
    });
    expect(Array.from((await index(bytes)).times)).toEqual([0x80000000 / 15360]);
  });

  it("编辑列表 v1（64 位）：一段、media_time ≥ 0", async () => {
    const { bytes } = buildMp4({
      ...B_FRAMES,
      ctts: { version: 0, rows: [[5, 1024]] },
      elst: { version: 1, rows: [[2000, 1024]] },
    });
    expect(Array.from((await index(bytes)).times)).toEqual([0, 512, 1024, 1536, 2048].map((t) => t / 15360));
  });

  it("编辑列表 0 段：当作没有", async () => {
    const { bytes } = buildMp4({ ...B_FRAMES, elst: { version: 0, rows: [] } });
    expect((await index(bytes)).editMediaTime).toBe(0);
  });

  it.each<[string, { version: number; rows: EditRow[] }, RegExp]>([
    [
      "空编辑 + 正常段（两段）",
      {
        version: 0,
        rows: [
          [100, -1],
          [2000, 0],
        ],
      },
      /2 段/,
    ],
    ["只有一段空编辑", { version: 0, rows: [[2000, -1]] }, /空编辑/],
    ["v1 的空编辑", { version: 1, rows: [[2000, -1]] }, /空编辑/],
    ["速率 2", { version: 0, rows: [[2000, 0, 2]] }, /速率/],
  ])("不支持的编辑列表：%s", async (_, edits, message) => {
    const { bytes } = buildMp4({ ...B_FRAMES, elst: edits });
    expect(await failure(bytes)).toMatch(message);
  });
});

describe("indexMp4：轨与样本项", () => {
  const SOUND = box(
    "trak",
    box("tkhd", new Uint8Array(84)),
    box("mdia", mdhd(44100, 88200), hdlr("soun"), box("minf", box("smhd", new Uint8Array(8)))),
  );

  it("视频轨前面有音频轨：取第一条 vide", async () => {
    const { bytes, samples } = buildMp4({ ...BASIC, before: [SOUND] });
    expectSamples(await index(bytes), bytes, samples);
  });

  it("没有视频轨", async () => {
    const bytes = concat(FTYP, box("moov", mvhd(1000, 2000), SOUND));
    expect(await failure(bytes)).toMatch(/没有视频轨/);
  });

  it.each([
    ["hvc1", "hevc"],
    ["hev1", "hevc"],
    ["avc3", "avc"],
  ])("样本项 %s → %s，description 是配置盒的内容", async (entry, codec) => {
    const { bytes } = buildMp4({ ...BASIC, entry });
    const track = await index(bytes);
    expect(track.codec).toBe(codec);
    expect(track.sampleEntry).toBe(entry);
    expect(track.description).toEqual(codec === "hevc" ? HVCC : AVCC);
  });

  it("编码不支持：av01", async () => {
    const { bytes } = buildMp4({ ...BASIC, entry: "av01", configType: "av1C" });
    expect(await failure(bytes)).toMatch(/av01/);
  });

  it("样本项里缺 avcC / avcC 太短", async () => {
    expect(await failure(buildMp4({ ...BASIC, configType: "pasp" }).bytes)).toMatch(/缺少 avcC/);
    expect(await failure(buildMp4({ ...BASIC, config: AVCC.slice(0, 4) }).bytes)).toMatch(/avcC 太短/);
  });

  it("colr：nclx 带范围位、nclc 没有范围位、ICC 忽略；取第一个能用的", async () => {
    const nclx = await index(buildMp4({ ...BASIC, extra: [colrNclx(1, 1, 1, true)] }).bytes);
    expect(nclx.colr).toEqual({ primaries: 1, transfer: 1, matrix: 1, fullRange: true });
    const nclc = box("colr", ascii("nclc"), u16be(6), u16be(1), u16be(6));
    expect((await index(buildMp4({ ...BASIC, extra: [nclc] }).bytes)).colr).toEqual({
      primaries: 6,
      transfer: 1,
      matrix: 6,
      fullRange: false,
    });
    const icc = box("colr", ascii("prof"), new Uint8Array(32));
    const both = await index(buildMp4({ ...BASIC, extra: [icc, colrNclx(9, 16, 9, false)] }).bytes);
    expect(both.colr).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: false });
    expect((await index(buildMp4({ ...BASIC, extra: [icc] }).bytes)).colr).toBeNull();
  });

  it("视觉样本项的宽高", async () => {
    const track = await index(buildMp4({ ...BASIC, width: 960, height: 540 }).bytes);
    expect([track.codedWidth, track.codedHeight]).toEqual([960, 540]);
  });

  it("stsc 引用第 2 个样本项", async () => {
    const { bytes } = buildMp4({ ...BASIC, stsc: [[1, 2, 2]], perChunk: [2, 2, 1] });
    expect(await failure(bytes)).toMatch(/样本项/);
  });
});

describe("indexMp4：时长", () => {
  it("mvhd 的 duration / timescale（和 containerDuration 一致）", async () => {
    expect((await index(buildMp4({ ...BASIC, movie: [90000, 900480] }).bytes)).duration).toBe(900480 / 90000);
  });

  it("没有 mvhd 或时长未知：退到 mdhd，再退到 stts 的总长", async () => {
    expect((await index(buildMp4({ ...BASIC, movie: null, mediaDuration: 3000 }).bytes)).duration).toBe(3000 / 15360);
    expect((await index(buildMp4({ ...BASIC, movie: [1000, 0xffffffff], mediaDuration: 3000 }).bytes)).duration).toBe(
      3000 / 15360,
    );
    expect((await index(buildMp4({ ...BASIC, movie: [1000, 0], mediaDuration: 0 }).bytes)).duration).toBe(
      (5 * 512) / 15360,
    );
  });
});

describe("indexMp4：失败（返回原因，不抛错）", () => {
  it("分片 MP4：顶层 moof、moov 里有 mvex", async () => {
    const moof = concat(FTYP, box("moof", new Uint8Array(16)), box("moov", mvhd(1000, 0)));
    expect(await failure(moof)).toMatch(/分片/);
    const { bytes } = buildMp4({ ...BASIC, moovExtra: [box("mvex", full("trex", 0, new Uint8Array(20)))] });
    expect(await failure(bytes)).toMatch(/分片/);
  });

  it("Matroska / 不认识的头 / 太短 / 没有 moov", async () => {
    const ebml = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]), new Uint8Array(40));
    expect(await failure(ebml)).toMatch(/Matroska/);
    expect(await failure(new Uint8Array(64).fill(0x01))).toMatch(/不是 MP4/);
    expect(await failure(new Uint8Array(4))).toMatch(/太短/);
    expect(await failure(concat(FTYP, box("free", new Uint8Array(8)), box("mdat", new Uint8Array(32))))).toMatch(
      /没有找到 moov/,
    );
  });

  it("截断：length 比 moov 的终点短、读到的字节不足、read 自己 reject", async () => {
    const { bytes } = buildMp4(BASIC);
    const moovEnd = bytes.length - (8 + 94);
    expect(await failure(bytes, moovEnd - 1)).toMatch(/越界/);
    expect(await failure(bytes.slice(0, FTYP.length + 100), bytes.length)).toMatch(/截断/);
    const reject: ReadRange = async () => {
      throw new Error("磁盘没了");
    };
    expect(await indexMp4(reject, 1000)).toEqual({ error: "读取或解析失败：磁盘没了" });
  });

  it("样本越过视频数据末尾", async () => {
    const { bytes } = buildMp4(BASIC);
    expect(await failure(bytes.slice(0, bytes.length - 1), bytes.length - 1)).toMatch(/越过视频数据末尾/);
  });

  it("表互相对不上：stts / ctts 少覆盖、stsc 分出的样本多或少、stss 越界", async () => {
    expect(await failure(buildMp4({ ...BASIC, stts: [[4, 512]] }).bytes)).toMatch(/stts 只覆盖 4/);
    expect(await failure(buildMp4({ ...BASIC, stts: [[6, 512]] }).bytes)).toMatch(/stts 的样本数多于/);
    expect(await failure(buildMp4({ ...BASIC, ctts: { version: 0, rows: [[3, 0]] } }).bytes)).toMatch(/ctts 只覆盖 3/);
    expect(await failure(buildMp4({ ...BASIC, stsc: [[1, 3, 1]] }).bytes)).toMatch(/多于/);
    expect(await failure(buildMp4({ ...BASIC, stsc: [[1, 1, 1]] }).bytes)).toMatch(/只分出 3/);
    expect(await failure(buildMp4({ ...BASIC, stss: [1, 6] }).bytes)).toMatch(/stss 的样本号 6/);
  });

  it("表被截断：stsz 的行数比内容多", async () => {
    const { bytes } = buildMp4(BASIC);
    // 把 stsz 的 sample_count 改大：表里只有 5 行
    new DataView(bytes.buffer).setUint32(findType(bytes, "stsz") + SAMPLE_COUNT, 6);
    expect(await failure(bytes)).toMatch(/stsz 表被截断/);
  });

  it("上限：样本数、moov 大小（不读内容）、顶层盒子数", async () => {
    const many = buildMp4({ ...BASIC, sizes: [1], perChunk: [1], stts: [[1, 1]], fixedSize: true }).bytes;
    new DataView(many.buffer).setUint32(findType(many, "stsz") + SAMPLE_COUNT, MAX_SAMPLES + 1);
    expect(await failure(many)).toMatch(/超过上限/);

    const size = MAX_MOOV_BYTES + 9;
    const head = concat(FTYP, u32be(size), ascii("moov"));
    const { read, calls } = memoryRead(concat(head, new Uint8Array(8)));
    const result = await indexMp4(read, FTYP.length + size);
    expect(result).toEqual({ error: expect.stringMatching(/moov 太大/) });
    expect(calls.every(([start, end]) => end - start <= 16)).toBe(true);

    const frees = concat(FTYP, ...Array.from({ length: MAX_TOP_BOXES }, () => box("free")), box("moov", mvhd(1, 1)));
    expect(await failure(frees)).toMatch(/顶层盒子超过/);
  });
});

/** stsz 的 sample_count 相对盒子起点：盒头 8 + version/flags 4 + sample_size 4。 */
const SAMPLE_COUNT = 16;

/** 第一个类型为 `type` 的盒子的起点（按字节搜，测试里的类型名不会在别处出现）。 */
function findType(bytes: Uint8Array, type: string): number {
  const name = ascii(type);
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (name.every((byte, k) => bytes[i + k] === byte)) return i - 4;
  }
  throw new Error(`没有 ${type}`);
}
