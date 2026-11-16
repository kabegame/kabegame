/**
 * Matroska 帧表（P9d 步骤 3）：手造的 EBML 字节（构造工具在 `testMkv.ts`）覆盖各种块与边界，另有两段本机 ffmpeg 8.0.1 现编的真实
 * 文件（同目录，断言里的帧数 / 关键帧 / pts / 大小 / 位置都由 ffprobe 核对过）：
 *
 * - `h264-bframes.mkv`（4922 字节，30 帧，B 帧，关键帧在 0 / 12 / 24，带 `Colour`）：
 *   `ffmpeg -f lavfi -i testsrc2=size=64x48:rate=25 -frames:v 30 -c:v libx264 -preset veryfast -bf 2 -g 12 -keyint_min 12
 *   -sc_threshold 0 -pix_fmt yuv420p -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv -bitexact h264-bframes.mkv`
 * - `hevc.mkv`（7199 字节，24 帧，B 帧，关键帧在 0 / 10）：
 *   `ffmpeg -f lavfi -i testsrc2=size=64x64:rate=30 -frames:v 24 -c:v libx265 -preset veryfast
 *   -x265-params "bframes=2:keyint=12:min-keyint=12:scenecut=0:log-level=error" -pix_fmt yuv420p -bitexact hevc.mkv`
 * - 核对：`ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags,pos,size -of csv=p=0 <文件>`（Matroska 的
 *   `pos` 是块内容的起点，块数据在它之后 4 字节：1 字节轨号 + 2 字节时间码 + 1 字节标志）。
 *
 * 语料（3816870245）的对照在 `ignore/p9/p9d/step3/corpus.ts`。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codecString, decoderConfig, wpeColor } from "./config";
import { indexVideo } from "./index";
import { indexMatroska, type MatroskaReadStats } from "./mkv";
import type { ReadRange, VideoTrackIndex } from "./mp4";
import {
  blockGroup,
  buildMkv,
  cluster,
  clusterUnknown,
  el,
  info,
  MKV,
  payload,
  simpleBlock,
  trackEntry,
  type TrackSpec,
  uintEl,
} from "./testMkv";
import { AVCC, buildMp4, concat, HVCC, memoryRead } from "./testMp4";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)));

async function index(bytes: Uint8Array, options: { chunkBytes?: number; stats?: MatroskaReadStats } = {}) {
  const result = await indexMatroska(memoryRead(bytes).read, bytes.length, options);
  if ("error" in result) throw new Error(`意外失败：${result.error}`);
  return result;
}

async function failure(bytes: Uint8Array, length = bytes.length): Promise<string> {
  const result = await indexMatroska(memoryRead(bytes).read, length);
  if (!("error" in result)) throw new Error("意外成功");
  return result.error;
}

const VIDEO: TrackSpec = {
  number: 1,
  type: 1,
  codecId: "V_MPEG4/ISO/AVC",
  codecPrivate: AVCC,
  width: 320,
  height: 180,
};
const AUDIO: TrackSpec = { number: 2, type: 2, codecId: "A_AAC", codecPrivate: Uint8Array.of(0x12, 0x10) };
const tracks = (...specs: TrackSpec[]) => el(MKV.Tracks, ...specs.map(trackEntry));
/** SimpleBlock 的关键帧标志。 */
const KEY = 0x80;

/** 每一帧的数据都要正好是写进去的 payload。 */
function expectPayloads(bytes: Uint8Array, track: VideoTrackIndex, tags: number[]): void {
  expect(track.offsets.length).toBe(tags.length);
  tags.forEach((tag, i) => {
    const data = bytes.subarray(track.offsets[i], track.offsets[i] + track.sizes[i]);
    expect(data[0], `第 ${i} 帧`).toBe(0xf0);
    expect(data[1], `第 ${i} 帧`).toBe(tag);
  });
}

// ———— 真实字节 ————

describe("indexMatroska：ffmpeg 现编的样例", () => {
  it("H.264 带 B 帧：帧数、显示时间、关键帧、大小、偏移与 ffprobe 一致；Colour → colr；时长取 Info.Duration", async () => {
    const bytes = fixture("h264-bframes.mkv");
    const track = await index(bytes);
    expect(track).toMatchObject({
      codec: "avc",
      sampleEntry: "avc1",
      codedWidth: 64,
      codedHeight: 48,
      timescale: 1000,
      duration: 1.2,
      editMediaTime: 0,
      colr: { primaries: 2, transfer: 2, matrix: 1, fullRange: false },
    });
    // ffprobe 的 pts_time（显示时间，解码顺序）
    const pts = [
      0, 0.12, 0.04, 0.08, 0.24, 0.16, 0.2, 0.36, 0.28, 0.32, 0.44, 0.4, 0.48, 0.6, 0.52, 0.56, 0.68, 0.64, 0.8, 0.72,
      0.76, 0.92, 0.84, 0.88, 0.96, 1.08, 1, 1.04, 1.16, 1.12,
    ];
    expect(Array.from(track.times)).toEqual(pts);
    expect(Array.from(track.keys).flatMap((key, i) => (key ? [i] : []))).toEqual([0, 12, 24]);
    expect(Array.from(track.sizes)).toEqual([
      1556, 58, 22, 13, 28, 14, 12, 37, 17, 12, 14, 12, 943, 39, 12, 12, 45, 13, 62, 14, 13, 75, 15, 14, 915, 99, 13,
      13, 44, 13,
    ]);
    const pos = [
      527, 2089, 2153, 2181, 2200, 2234, 2254, 2272, 2315, 2338, 2356, 2376, 2395, 3344, 3389, 3407, 3425, 3476, 3495,
      3563, 3583, 3602, 3683, 3704, 3725, 4646, 4751, 4770, 4789, 4839,
    ];
    expect(Array.from(track.offsets)).toEqual(pos.map((at) => at + 4));
    // 关键帧的数据以 NAL 长度开头（avcC 的 lengthSizeMinusOne = 3）
    expect(track.description[0]).toBe(1);
    expect(codecString(track)).toBe("avc1.64000a");
    expect(decoderConfig(track, "scene")).toMatchObject({ codec: "avc1.64000a", codedWidth: 64, codedHeight: 48 });
    expect(wpeColor(track, "user")).toMatchObject({ source: "colr", matrix: "bt709" });
  });

  it("HEVC 带 B 帧：codec 串照 hvc1，帧表与 ffprobe 一致（pts 是毫秒时间码）", async () => {
    const bytes = fixture("hevc.mkv");
    const track = await index(bytes);
    expect(track).toMatchObject({
      codec: "hevc",
      sampleEntry: "hvc1",
      codedWidth: 64,
      codedHeight: 64,
      timescale: 1000,
      duration: 0.8,
      editMediaTime: 0,
    });
    expect(Array.from(track.times)).toEqual([
      0, 0.1, 0.067, 0.033, 0.2, 0.167, 0.133, 0.3, 0.267, 0.233, 0.4, 0.367, 0.333, 0.5, 0.467, 0.433, 0.6, 0.567,
      0.533, 0.7, 0.667, 0.633, 0.767, 0.733,
    ]);
    expect(Array.from(track.keys).flatMap((key, i) => (key ? [i] : []))).toEqual([0, 10]);
    expect(Array.from(track.sizes)).toEqual([
      954, 194, 37, 22, 291, 46, 42, 181, 37, 21, 1151, 49, 44, 234, 52, 22, 207, 38, 19, 218, 48, 39, 105, 24,
    ]);
    const pos = [
      2928, 3889, 4089, 4132, 4161, 4458, 4510, 4559, 4746, 4789, 4817, 5974, 6029, 6080, 6320, 6378, 6407, 6620, 6664,
      6690, 6914, 6968, 7013, 7124,
    ];
    expect(Array.from(track.offsets)).toEqual(pos.map((at) => at + 4));
    expect(codecString(track)).toBe("hvc1.1.6.L30.90");
  });

  it("真实样例按任意块大小读，结果都相同（跨块边界的元素接得上）", async () => {
    for (const name of ["h264-bframes.mkv", "hevc.mkv"]) {
      const bytes = fixture(name);
      const whole = await index(bytes);
      for (const chunkBytes of [1, 2, 3, 5, 7, 13, 64, 500, 1000, 4096]) {
        const stats: MatroskaReadStats = { reads: 0, bytes: 0 };
        expect(await index(bytes, { chunkBytes, stats }), `${name} 块 ${chunkBytes}`).toEqual(whole);
        expect(stats.bytes).toBeLessThanOrEqual(bytes.length + 64);
      }
    }
  });

  it("顺序读：缺省一块就读完小文件，读的字节不超过文件长度", async () => {
    const bytes = fixture("h264-bframes.mkv");
    const stats: MatroskaReadStats = { reads: 0, bytes: 0 };
    await index(bytes, { stats });
    expect(stats).toEqual({ reads: 1, bytes: bytes.length });
  });
});

// ———— 手造字节 ————

describe("indexMatroska：块与时间", () => {
  it("SimpleBlock 的 0x80 是关键帧；BlockGroup 没有 ReferenceBlock 是关键帧、有的不是；偏移与长度去掉块头", async () => {
    const bytes = buildMkv([
      info(),
      tracks(VIDEO),
      cluster(
        0,
        simpleBlock(1, 0, KEY, payload(1)),
        simpleBlock(1, 40, 0, payload(2, 12)),
        blockGroup(1, 80, payload(3)),
        blockGroup(1, 120, payload(4, 9), [40]),
        // 0x80 以外的标志位（不可见、可丢弃）不影响
        simpleBlock(1, 160, 0x08 | 0x01, payload(5)),
      ),
    ]);
    const track = await index(bytes);
    expect(Array.from(track.keys)).toEqual([1, 0, 1, 0, 0]);
    expect(Array.from(track.sizes)).toEqual([8, 12, 8, 9, 8]);
    expect(Array.from(track.times)).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
    expectPayloads(bytes, track, [1, 2, 3, 4, 5]);
  });

  it("时间 = (Cluster 时间码 + 有符号相对时间码) × TimecodeScale：负的相对时间码、跨 Cluster", async () => {
    const bytes = buildMkv([
      info(),
      tracks(VIDEO),
      cluster(
        1000,
        simpleBlock(1, 0, KEY, payload(1)),
        simpleBlock(1, 100, 0, payload(2)),
        simpleBlock(1, -50, 0, payload(3)),
      ),
      cluster(1200, simpleBlock(1, -100, 0, payload(4)), simpleBlock(1, 32767, 0, payload(5))),
    ]);
    const track = await index(bytes);
    // 最小的显示时间是 950：减掉之后首帧在 0.05
    expect(Array.from(track.times)).toEqual([0.05, 0.15, 0, 0.15, 33.017]);
    expect(track.editMediaTime).toBe(950);
    expect(track.timescale).toBe(1000);
  });

  it("B 帧：解码顺序第一帧的显示时间不是最小时，按最早显示的帧扣成 0", async () => {
    const bytes = buildMkv([
      info(),
      tracks(VIDEO),
      cluster(
        0,
        simpleBlock(1, 80, KEY, payload(1)),
        simpleBlock(1, 160, 0, payload(2)),
        simpleBlock(1, 40, 0, payload(3)),
        simpleBlock(1, 120, 0, payload(4)),
      ),
    ]);
    const track = await index(bytes);
    expect(Array.from(track.times)).toEqual([0.04, 0.12, 0, 0.08]);
    expect(track.editMediaTime).toBe(40);
  });

  it("TimecodeScale 非缺省：时间与时长都乘它，timescale 是每秒的时间码数", async () => {
    const bytes = buildMkv([
      info(100_000, 30, 4),
      tracks(VIDEO),
      cluster(
        5,
        simpleBlock(1, 0, KEY, payload(1)),
        simpleBlock(1, 10, 0, payload(2)),
        simpleBlock(1, 20, 0, payload(3)),
      ),
    ]);
    const track = await index(bytes);
    expect(Array.from(track.times)).toEqual([0, 0.001, 0.002]);
    expect(track.timescale).toBe(10_000);
    expect(track.editMediaTime).toBe(5);
    // Duration 是 float32 的 30 个时间码 = 3 ms（和 containerDuration 同一个口径）
    expect(track.duration).toBeCloseTo(0.003, 12);
  });

  it("没有 Duration：最大显示时间 + 相邻显示时间之差的中位数", async () => {
    const bytes = buildMkv([
      info(),
      tracks(VIDEO),
      cluster(
        0,
        simpleBlock(1, 0, KEY, payload(1)),
        simpleBlock(1, 80, 0, payload(2)),
        simpleBlock(1, 40, 0, payload(3)),
        simpleBlock(1, 120, 0, payload(4)),
        simpleBlock(1, 200, 0, payload(5)),
      ),
    ]);
    // 显示时间 0 40 80 120 200，差 40 40 40 80，中位数 40
    expect((await index(bytes)).duration).toBeCloseTo(0.24, 12);
  });

  it("没有 Duration、只有一帧：取轨的 DefaultDuration（纳秒），也没有时为 0；Duration 为 0 当作没有", async () => {
    const one = (defaultDuration?: number, duration?: number) =>
      buildMkv([
        info(undefined, duration),
        tracks({ ...VIDEO, defaultDuration }),
        cluster(0, simpleBlock(1, 0, KEY, payload(1))),
      ]);
    expect((await index(one(33_333_333))).duration).toBeCloseTo(0.033333333, 9);
    expect((await index(one())).duration).toBe(0);
    expect((await index(one(40_000_000, 0))).duration).toBeCloseTo(0.04, 12);
  });

  it("只收第一条视频轨的块：音轨（带 lacing 也不管）与第二条视频轨的块跳过", async () => {
    const second: TrackSpec = { ...VIDEO, number: 3 };
    const bytes = buildMkv([
      info(),
      tracks(AUDIO, VIDEO, second),
      cluster(
        0,
        simpleBlock(2, 0, KEY | 0x02, payload(9, 20)),
        simpleBlock(1, 0, KEY, payload(1)),
        simpleBlock(3, 0, KEY, payload(7)),
        blockGroup(2, 10, payload(9)),
        simpleBlock(1, 40, 0, payload(2)),
      ),
    ]);
    const track = await index(bytes);
    expectPayloads(bytes, track, [1, 2]);
  });

  it("Colour：码值填进 colr、Range 2 是 full；缺的码值记 2（未指定），矩阵 2 时 wpeColor 往 SPS 找", async () => {
    const full = await index(
      buildMkv([
        info(),
        tracks({
          ...VIDEO,
          colour: [
            [MKV.MatrixCoefficients, 6],
            [MKV.Primaries, 5],
            [MKV.TransferCharacteristics, 6],
            [MKV.Range, 2],
          ],
        }),
        cluster(0, simpleBlock(1, 0, KEY, payload(1))),
      ]),
    );
    expect(full.colr).toEqual({ primaries: 5, transfer: 6, matrix: 6, fullRange: true });
    expect(wpeColor(full, "user")).toMatchObject({ matrix: "smpte170m", source: "colr" });
    const partial = await index(
      buildMkv([
        info(),
        tracks({ ...VIDEO, colour: [[MKV.Range, 1]] }),
        cluster(0, simpleBlock(1, 0, KEY, payload(1))),
      ]),
    );
    expect(partial.colr).toEqual({ primaries: 2, transfer: 2, matrix: 2, fullRange: false });
    expect(wpeColor(partial, "user").source).not.toBe("colr");
    const none = await index(buildMkv([info(), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY, payload(1)))]));
    expect(none.colr).toBeNull();
  });

  it("HEVC：CodecPrivate 即 hvcC，sampleEntry 为 hvc1", async () => {
    const track = await index(
      buildMkv([
        info(),
        tracks({ ...VIDEO, codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HVCC }),
        cluster(0, simpleBlock(1, 0, KEY, payload(1))),
      ]),
    );
    expect(track).toMatchObject({ codec: "hevc", sampleEntry: "hvc1", description: HVCC });
  });

  it("WebM 的 DocType 也认；跳过 SeekHead / Void / Cues / Tags 与轨里不认识的元素", async () => {
    const bytes = buildMkv(
      [
        el(MKV.SeekHead, el(0x4dbb, uintEl(0x53ac, 1))),
        el(MKV.Void, new Uint8Array(30)),
        info(),
        tracks({ ...VIDEO, extra: [uintEl(0x9c, 0), el(MKV.Void, new Uint8Array(3))] }),
        el(MKV.Tags, new Uint8Array(10)),
        cluster(0, el(MKV.Void, new Uint8Array(4)), simpleBlock(1, 0, KEY, payload(1))),
        el(MKV.Cues, new Uint8Array(20)),
      ],
      { docType: "webm" },
    );
    expectPayloads(bytes, await index(bytes), [1]);
  });
});

describe("indexMatroska：未知大小", () => {
  it("未知大小的 Cluster 读到下一个 Cluster / Cues 为止", async () => {
    const bytes = buildMkv([
      info(),
      tracks(VIDEO),
      clusterUnknown(0, simpleBlock(1, 0, KEY, payload(1)), blockGroup(1, 40, payload(2), [40])),
      clusterUnknown(100, simpleBlock(1, -20, 0, payload(3))),
      cluster(200, simpleBlock(1, 0, KEY, payload(4))),
      clusterUnknown(300, simpleBlock(1, 0, 0, payload(5))),
      el(MKV.Cues, new Uint8Array(12)),
    ]);
    const track = await index(bytes);
    expectPayloads(bytes, track, [1, 2, 3, 4, 5]);
    expect(Array.from(track.times)).toEqual([0, 0.04, 0.08, 0.2, 0.3]);
    expect(Array.from(track.keys)).toEqual([1, 0, 0, 1, 0]);
  });

  it("未知大小的 Segment 与最后一个未知大小的 Cluster 读到视频末尾", async () => {
    const bytes = buildMkv(
      [
        info(),
        tracks(VIDEO),
        clusterUnknown(0, simpleBlock(1, 0, KEY, payload(1)), simpleBlock(1, 40, 0, payload(2))),
        clusterUnknown(80, simpleBlock(1, 0, 0, payload(3))),
      ],
      { unknownSegment: true },
    );
    for (const chunkBytes of [3, 16, 4096]) {
      const track = await index(bytes, { chunkBytes });
      expectPayloads(bytes, track, [1, 2, 3]);
    }
  });

  it("未知大小的 Segment 遇到下一个 EBML 头就停（串接的文件只看第一段）", async () => {
    const first = buildMkv([info(), tracks(VIDEO), clusterUnknown(0, simpleBlock(1, 0, KEY, payload(1)))], {
      unknownSegment: true,
    });
    const second = buildMkv([info(), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY, payload(2)))]);
    const track = await index(concat(first, second));
    expect(track.offsets.length).toBe(1);
  });
});

describe("indexMatroska：失败", () => {
  const good = () => buildMkv([info(), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY, payload(1)))]);

  it("视频块用了 lacing", async () => {
    for (const lacing of [0x02, 0x04, 0x06]) {
      const bytes = buildMkv([info(), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY | lacing, payload(1)))]);
      expect(await failure(bytes)).toMatch(/lacing/);
    }
  });

  it("没有视频轨、编码不支持、缺 CodecPrivate、avcC 太短、带 ContentEncodings", async () => {
    expect(await failure(buildMkv([info(), tracks(AUDIO), cluster(0, simpleBlock(2, 0, KEY, payload(1)))]))).toMatch(
      /没有视频轨/,
    );
    expect(await failure(buildMkv([info(), tracks({ ...VIDEO, codecId: "V_VP9" })]))).toMatch(/V_VP9 不支持/);
    expect(await failure(buildMkv([info(), tracks({ ...VIDEO, codecPrivate: undefined })]))).toMatch(
      /缺少 CodecPrivate/,
    );
    expect(await failure(buildMkv([info(), tracks({ ...VIDEO, codecPrivate: Uint8Array.of(1, 2) })]))).toMatch(
      /avcC 太短/,
    );
    expect(
      await failure(buildMkv([info(), tracks({ ...VIDEO, extra: [el(MKV.ContentEncodings, new Uint8Array(4))] })])),
    ).toMatch(/ContentEncodings/);
  });

  it("编码不支持时不往下读 Cluster", async () => {
    const bytes = buildMkv([info(), tracks({ ...VIDEO, codecId: "V_AV1" }), cluster(0, new Uint8Array(100_000))]);
    const { read, calls } = memoryRead(bytes);
    const result = await indexMatroska(read, bytes.length, { chunkBytes: 256 });
    expect(result).toMatchObject({ error: expect.stringMatching(/V_AV1/) });
    expect(Math.max(...calls.map(([, end]) => end))).toBeLessThan(1000);
  });

  it("没有帧、没有 Tracks、Cluster 在 Tracks 之前、块在 Timecode 之前、TimecodeScale 为 0", async () => {
    expect(await failure(buildMkv([info(), tracks(VIDEO)]))).toMatch(/没有帧/);
    expect(await failure(buildMkv([info()]))).toMatch(/没有 Tracks/);
    expect(await failure(buildMkv([info(), cluster(0, simpleBlock(1, 0, KEY, payload(1))), tracks(VIDEO)]))).toMatch(
      /Tracks 之前/,
    );
    const noTimecode = el(MKV.Cluster, simpleBlock(1, 0, KEY, payload(1)));
    expect(await failure(buildMkv([info(), tracks(VIDEO), noTimecode]))).toMatch(/Timecode 之前/);
    expect(await failure(buildMkv([info(0), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY, payload(1)))]))).toMatch(
      /TimecodeScale 为 0/,
    );
  });

  it("不是 Matroska、DocType 不认识、EBML 头太大、EBML 头之后不是 Segment", async () => {
    expect(await failure(new Uint8Array(64))).toMatch(/不是 Matroska/);
    expect(await failure(buildMkv([info()], { docType: "mka2" }))).toMatch(/DocType mka2/);
    const big = concat(el(MKV.EBML, new Uint8Array(5000)), el(MKV.Segment, info()));
    expect(await failure(big)).toMatch(/EBML 头太大/);
    const notSegment = concat(el(MKV.EBML, uintEl(0x4286, 1)), el(MKV.Tags, info()));
    expect(await failure(notSegment)).toMatch(/不是 Segment/);
  });

  it("截断：长度短于 Segment 声明的大小、块数据越过末尾、块头比 4 字节还短", async () => {
    const bytes = good();
    expect(await failure(bytes.subarray(0, bytes.length - 3))).toMatch(/越界/);
    // 声明的长度比实际字节多：读被截断
    expect(await failure(bytes, bytes.length + 100)).toMatch(/越界|截断/);
    const short = buildMkv([info(), tracks(VIDEO), cluster(0, el(MKV.SimpleBlock, Uint8Array.of(0x81, 0)))]);
    expect(await failure(short)).toMatch(/块头畸形/);
  });

  it("read 自己 reject、长度太短：返回原因、不抛错", async () => {
    const reject: ReadRange = () => Promise.reject(new Error("磁盘没了"));
    expect(await indexMatroska(reject, 1000)).toEqual({ error: "读取或解析失败：磁盘没了" });
    expect(await indexMatroska(reject, 4)).toMatchObject({ error: expect.stringMatching(/太短/) });
  });
});

describe("indexVideo：按魔数分派", () => {
  it("EBML 魔数走 Matroska，其余走 MP4；读失败返回原因", async () => {
    const mkv = buildMkv([info(), tracks(VIDEO), cluster(0, simpleBlock(1, 0, KEY, payload(1)))]);
    const fromMkv = await indexVideo(memoryRead(mkv).read, mkv.length);
    expect(fromMkv).toMatchObject({ codec: "avc", timescale: 1000, codedWidth: 320 });
    const mp4 = buildMp4({ sizes: [10, 10], perChunk: [2], stts: [[2, 100]], timescale: 1000 }).bytes;
    const fromMp4 = await indexVideo(memoryRead(mp4).read, mp4.length);
    expect(fromMp4).toMatchObject({ codec: "avc", timescale: 1000, codedWidth: 1920 });
    expect(Array.from((fromMp4 as VideoTrackIndex).times)).toEqual([0, 0.1]);
    // MP4 读不了的东西照样走 MP4 的原因
    expect(await indexVideo(memoryRead(new Uint8Array(64)).read, 64)).toEqual({
      error: "不是 MP4：第一个盒子头不认识",
    });
    expect(await indexVideo(() => Promise.reject(new Error("断了")), 100)).toEqual({ error: "读取或解析失败：断了" });
  });

  it("真实 Matroska 样例经 indexVideo 和直接 indexMatroska 一样", async () => {
    const bytes = fixture("hevc.mkv");
    expect(await indexVideo(memoryRead(bytes).read, bytes.length)).toEqual(await index(bytes));
  });
});
