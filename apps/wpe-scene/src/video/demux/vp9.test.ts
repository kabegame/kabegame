/**
 * VP9 码流工具（P9e）：关键帧帧头、`CodecPrivate` 的 level、level 表、color_space → 矩阵码。
 * 真实字节是关键帧块数据的开头 12 字节（ffprobe 的 pos + 4 跳过块头）：`vp9.webm` / `vp9-10bit.webm` 是同目录的 ffmpeg 样例
 * （命令见 `mkv.test.ts`），语料是 3662390671 `materials/Scene.tex` 里的 WebM。其余按 VP9 码流规范 6.2 用位写入器合成。
 */
import { describe, expect, it } from "vitest";
import { parseVp9KeyFrame, VP9_LEVELS, vp9CodecPrivateLevel, vp9Level, vp9MatrixCode } from "./vp9";

function hex(text: string): Uint8Array {
  return new Uint8Array(text.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

/** 按位写（大端、高位在前），最后补 0 到整字节。 */
class BitWriter {
  private bits: number[] = [];
  put(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
    return out;
  }
}

interface HeaderSpec {
  marker?: number;
  profile: number;
  reserved?: number;
  showExisting?: number;
  frameType?: number;
  sync?: [number, number, number];
  twelveBit?: number;
  colorSpace: number;
  fullRange?: number;
  subsampling?: [number, number];
  colorReserved?: number;
  width?: number;
  height?: number;
}

/** 合成关键帧帧头到 frame_size 为止（规范 6.2 的顺序）。 */
function header(spec: HeaderSpec): Uint8Array {
  const w = new BitWriter();
  const profile = spec.profile;
  w.put(spec.marker ?? 2, 2)
    .put(profile & 1, 1)
    .put(profile >> 1, 1);
  if (profile === 3) w.put(spec.reserved ?? 0, 1);
  w.put(spec.showExisting ?? 0, 1);
  if (spec.showExisting) return w.put(0, 3).bytes();
  w.put(spec.frameType ?? 0, 1)
    .put(1, 1) // show_frame
    .put(0, 1); // error_resilient_mode
  for (const byte of spec.sync ?? [0x49, 0x83, 0x42]) w.put(byte, 8);
  if (profile >= 2) w.put(spec.twelveBit ?? 0, 1);
  w.put(spec.colorSpace, 3);
  const pro13 = profile === 1 || profile === 3;
  if (spec.colorSpace !== 7) {
    w.put(spec.fullRange ?? 0, 1);
    if (pro13)
      w.put(spec.subsampling?.[0] ?? 1, 1)
        .put(spec.subsampling?.[1] ?? 1, 1)
        .put(spec.colorReserved ?? 0, 1);
  } else if (pro13) w.put(spec.colorReserved ?? 0, 1);
  w.put((spec.width ?? 1920) - 1, 16).put((spec.height ?? 1080) - 1, 16);
  return w.bytes();
}

describe("parseVp9KeyFrame：真实字节", () => {
  it("ffmpeg 样例 vp9.webm：profile 0、8 位、4:2:0、color_space 未知、limited、64×48", () => {
    expect(parseVp9KeyFrame(hex("824983420003f002f6003824"))).toEqual({
      profile: 0,
      bitDepth: 8,
      subsamplingX: 1,
      subsamplingY: 1,
      colorSpace: 0,
      fullRange: false,
      width: 64,
      height: 48,
    });
  });

  it("ffmpeg 样例 vp9-10bit.webm（-profile:v 2 -colorspace bt709 -color_range pc）：10 位、BT.709、full", () => {
    expect(parseVp9KeyFrame(hex("924983422801f8017b041c12"))).toEqual({
      profile: 2,
      bitDepth: 10,
      subsamplingX: 1,
      subsamplingY: 1,
      colorSpace: 2,
      fullRange: true,
      width: 64,
      height: 48,
    });
  });

  it("语料 3662390671 的背景视频：profile 0、color_space 未知、limited、1920×1080", () => {
    expect(parseVp9KeyFrame(hex("824983420077f04376003824"))).toMatchObject({
      profile: 0,
      bitDepth: 8,
      colorSpace: 0,
      fullRange: false,
      width: 1920,
      height: 1080,
    });
  });
});

describe("parseVp9KeyFrame：合成帧头", () => {
  it.each<[string, HeaderSpec, object]>([
    ["profile 0", { profile: 0, colorSpace: 2, fullRange: 1 }, { bitDepth: 8, subsamplingX: 1, subsamplingY: 1 }],
    [
      "profile 1 4:4:4",
      { profile: 1, colorSpace: 1, subsampling: [0, 0] },
      { bitDepth: 8, subsamplingX: 0, subsamplingY: 0, colorSpace: 1 },
    ],
    [
      "profile 1 4:2:2",
      { profile: 1, colorSpace: 2, subsampling: [1, 0] },
      { bitDepth: 8, subsamplingX: 1, subsamplingY: 0 },
    ],
    ["profile 2 10 位", { profile: 2, colorSpace: 5, twelveBit: 0 }, { bitDepth: 10, colorSpace: 5 }],
    ["profile 2 12 位", { profile: 2, colorSpace: 2, twelveBit: 1 }, { bitDepth: 12 }],
    [
      "profile 3 12 位 4:4:4（带保留位）",
      { profile: 3, colorSpace: 3, twelveBit: 1, subsampling: [0, 0] },
      { profile: 3, bitDepth: 12, subsamplingX: 0, subsamplingY: 0, colorSpace: 3 },
    ],
    [
      "profile 1 RGB：full range、4:4:4",
      { profile: 1, colorSpace: 7 },
      { colorSpace: 7, fullRange: true, subsamplingX: 0, subsamplingY: 0 },
    ],
    [
      "尺寸 1 × 65536（16 位减 1 的两端）",
      { profile: 0, colorSpace: 0, width: 1, height: 65536 },
      { width: 1, height: 65536 },
    ],
  ])("%s", (_, spec, expected) => {
    expect(parseVp9KeyFrame(header(spec))).toMatchObject({ profile: spec.profile, ...expected });
  });

  it.each<[string, HeaderSpec, RegExp]>([
    ["frame_marker 不是 2", { profile: 0, colorSpace: 0, marker: 1 }, /frame_marker/],
    ["profile 3 保留位非 0", { profile: 3, colorSpace: 0, reserved: 1 }, /保留位/],
    ["show_existing_frame", { profile: 0, colorSpace: 0, showExisting: 1 }, /show_existing_frame/],
    ["不是关键帧", { profile: 0, colorSpace: 0, frameType: 1 }, /不是关键帧/],
    ["sync code 不对", { profile: 0, colorSpace: 0, sync: [0x49, 0x83, 0x43] }, /sync_code/],
    ["profile 0 不允许 RGB", { profile: 0, colorSpace: 7 }, /不允许 RGB/],
    ["profile 2 不允许 RGB", { profile: 2, colorSpace: 7 }, /不允许 RGB/],
    ["color_config 保留位非 0", { profile: 1, colorSpace: 1, colorReserved: 1 }, /保留位/],
  ])("失败：%s", (_, spec, message) => {
    expect(() => parseVp9KeyFrame(header(spec))).toThrow(message);
  });

  it("截断：缺 frame_size 的最后一个字节", () => {
    const bytes = header({ profile: 0, colorSpace: 0 });
    expect(() => parseVp9KeyFrame(bytes.subarray(0, bytes.length - 1))).toThrow(/截断/);
    expect(() => parseVp9KeyFrame(new Uint8Array(0))).toThrow(/截断/);
  });
});

describe("vp9Level：照 VP9 规范附录 A 的表", () => {
  it.each<[string, number, number, number | null, number]>([
    ["64×48 30 fps", 64, 48, 30, 10],
    ["1080p30", 1920, 1080, 30, 40],
    ["1080p60（采样率超过 4.0）", 1920, 1080, 60, 41],
    ["1080p 帧率未知：只看画面", 1920, 1080, null, 40],
    ["4K60", 3840, 2160, 60, 51],
    ["4K120", 3840, 2160, 120, 52],
    ["8K60", 7680, 4320, 60, 61],
    ["画面超出 6.x：取 62", 8192, 8192, 1, 62],
    ["帧率 NaN 当未知", 1920, 1080, Number.NaN, 40],
    ["帧率 0 当未知", 1920, 1080, 0, 40],
  ])("%s → %d", (_, width, height, fps, level) => {
    expect(vp9Level(width, height, fps)).toBe(level);
  });

  it("表按 level 升序、两列都不减", () => {
    for (let i = 1; i < VP9_LEVELS.length; i++) {
      expect(VP9_LEVELS[i][0]).toBeGreaterThan(VP9_LEVELS[i - 1][0]);
      expect(VP9_LEVELS[i][1]).toBeGreaterThanOrEqual(VP9_LEVELS[i - 1][1]);
      expect(VP9_LEVELS[i][2]).toBeGreaterThanOrEqual(VP9_LEVELS[i - 1][2]);
    }
  });
});

describe("vp9CodecPrivateLevel：VP9 codec feature metadata 里的 level（ID 2）", () => {
  it.each<[string, number[], number | null]>([
    ["profile、level、位深三项", [1, 1, 0, 2, 1, 41, 3, 1, 8], 41],
    ["只有 level", [2, 1, 62], 62],
    ["没有 level", [1, 1, 0, 3, 1, 8], null],
    ["level 不在表里", [2, 1, 15], null],
    ["level 长度不是 1：跳过", [2, 2, 0, 41], null],
    ["截断", [1, 1, 0, 2, 1], null],
    ["空", [], null],
  ])("%s", (_, bytes, level) => {
    expect(vp9CodecPrivateLevel(Uint8Array.from(bytes))).toBe(level);
  });
});

describe("vp9MatrixCode：color_space → ISO/IEC 23091-2 矩阵码（同 ffmpeg 的 vp9 解码器）", () => {
  it("八个值与越界", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(vp9MatrixCode)).toEqual([2, 5, 1, 6, 7, 9, 2, 0, 2]);
  });
});
