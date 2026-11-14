/**
 * 解码配置（P9d 步骤 1 点 2）：codec 串、照 WPE（Media Foundation）的色彩空间、H.264 SPS 的 VUI。
 * 真实字节注明来源：语料段（`ignore/p9/out/vtex.json` 的 sample，ffprobe 的 color_space 对照见语料扫描）或本机 ffmpeg 现编的样片
 * （命令写在用到的地方，ffprobe 核对过宽高与色彩）；其余按 ITU-T H.264 7.3.2.1.1 用位写入器合成。
 */
import { describe, expect, it } from "vitest";
import {
  codecString,
  decoderConfig,
  firstAvcSps,
  matrixFromCode,
  MF_HD_MIN_HEIGHT,
  parseAvcSps,
  unescapeRbsp,
  wpeColor,
  wpeColorSpace,
} from "./config";
import type { Mp4Colr, VideoTrackIndex } from "./mp4";

function hex(text: string): Uint8Array {
  return new Uint8Array(text.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

// ———— 真实 SPS（含 1 字节 NAL 头） ————

/** 语料 2887099508 `materials/1.tex`：High、1920×1080（1088 裁 8）、VUI 标 bt709 / limited。 */
const SPS_1080_BT709 = hex("67640028acd940780227e5c05a808080a0000003002000000791e30632c0");
/** 语料 3400241651：High、960×540、VUI 标 bt470bg（矩阵 5，原色 / 传递 2「未指定」）/ limited；含防竞争字节 `00 00 03`。 */
const SPS_540_BT470BG = hex("6764001facd940f0117ee6a04040a800000300080003c00078c18cb0");
/**
 * ffmpeg + libx264 现编：`-f lavfi -i testsrc=size=1920x1080 -pix_fmt yuv422p10le -c:v libx264
 * -x264-params avcintra-class=100:colormatrix=bt470bg:colorprim=bt709:transfer=bt709 -f h264`。
 * High 4:2:2 Intra（122），AVC-Intra 把 scaling list 写进 SPS（8 个表），VUI 矩阵 5 / limited（ffprobe：bt470bg、tv）。
 */
const SPS_AVCI100 = hex(
  "677a1029b6d420223319c6632321011198ce331918210256b93d7d7e4fe33f11f19e08b88c5443c0780227e27016a02020a80000030008000003019420",
);
/** 同上 `avcintra-class=50`、1440×1080、`yuv420p10le`、不带颜色参数：High 10 Intra（110），SPS 带 scaling list，VUI 没有颜色描述。 */
const SPS_AVCI50 = hex(
  "676e1028a6d42032330c7118886210191986388c44302102564e6f37cdf9bf816bf37cde6e6cd33c05a0227e5c3840000003004000000ca1",
);
/** ffmpeg + libx264：`testsrc=size=320x180`、High、`colormatrix=smpte170m:fullrange=on`：裁剪（192 → 180）、VUI 矩阵 6 / full。 */
const SPS_180_FULL = hex("6764000dacd941419f9f016e02020c80000003008000001e078a14cb");
/** ffmpeg + libx264：`testsrc=size=320x240`、Constrained Baseline：没有 High 系字段，VUI 没有颜色描述。 */
const SPS_BASELINE = hex("6742c00dd90141fb0110000003001000000303c0f142a480");

// ———— 合成 SPS ————

class BitWriter {
  bits: number[] = [];
  u(n: number, value: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  ue(value: number): this {
    const code = value + 1;
    const length = Math.floor(Math.log2(code));
    return this.u(length, 0).u(length + 1, code);
  }
  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  /** rbsp_trailing_bits 之后补齐字节。 */
  rbsp(): Uint8Array {
    const bits = [...this.bits, 1];
    while (bits.length % 8) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
    return out;
  }
}

/** 加防竞争字节：两个 0 之后跟 0–3 时插一个 03。 */
function escape(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

interface SpsSpec {
  profile: number;
  chromaFormat?: number;
  /** 每个表：null = 不出现；数组 = delta_scale 序列（读到 nextScale 为 0 或表满为止）。 */
  scalingLists?: (number[] | null)[];
  pocType?: number;
  widthMbs: number;
  heightMapUnits: number;
  frameMbsOnly?: boolean;
  crop?: [left: number, right: number, top: number, bottom: number];
  vui?: {
    aspect?: number | [number, number];
    overscan?: boolean;
    signal?: { fullRange: boolean; colour?: [primaries: number, transfer: number, matrix: number] };
  } | null;
}

function synthSps(spec: SpsSpec): Uint8Array {
  const w = new BitWriter();
  w.u(8, spec.profile).u(8, 0).u(8, 40).ue(0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(spec.profile)) {
    const chroma = spec.chromaFormat ?? 1;
    w.ue(chroma);
    if (chroma === 3) w.u(1, 0);
    w.ue(0).ue(0).u(1, 0);
    if (spec.scalingLists) {
      w.u(1, 1);
      for (const list of spec.scalingLists) {
        w.u(1, list ? 1 : 0);
        for (const delta of list ?? []) w.se(delta);
      }
    } else w.u(1, 0);
  }
  w.ue(0); // log2_max_frame_num_minus4
  const poc = spec.pocType ?? 0;
  w.ue(poc);
  if (poc === 0) w.ue(2);
  else if (poc === 1) w.u(1, 0).se(-3).se(5).ue(3).se(1).se(-200).se(7);
  w.ue(4).u(1, 0);
  w.ue(spec.widthMbs - 1).ue(spec.heightMapUnits - 1);
  const frameMbsOnly = spec.frameMbsOnly ?? true;
  w.u(1, frameMbsOnly ? 1 : 0);
  if (!frameMbsOnly) w.u(1, 1);
  w.u(1, 1);
  if (spec.crop) {
    w.u(1, 1);
    for (const value of spec.crop) w.ue(value);
  } else w.u(1, 0);
  const vui = spec.vui;
  if (!vui) w.u(1, 0);
  else {
    w.u(1, 1);
    if (vui.aspect === undefined) w.u(1, 0);
    else if (typeof vui.aspect === "number") w.u(1, 1).u(8, vui.aspect);
    else w.u(1, 1).u(8, 255).u(16, vui.aspect[0]).u(16, vui.aspect[1]);
    if (vui.overscan === undefined) w.u(1, 0);
    else w.u(1, 1).u(1, vui.overscan ? 1 : 0);
    if (!vui.signal) w.u(1, 0);
    else {
      w.u(1, 1)
        .u(3, 5)
        .u(1, vui.signal.fullRange ? 1 : 0);
      if (vui.signal.colour) w.u(1, 1).u(8, vui.signal.colour[0]).u(8, vui.signal.colour[1]).u(8, vui.signal.colour[2]);
      else w.u(1, 0);
    }
    w.u(1, 0); // chroma_loc_info_present_flag（之后的字段不读）
  }
  return new Uint8Array([0x67, ...escape(w.rbsp())]);
}

// ———— 轨 ————

/** avcC：configurationVersion profile compat level、4 字节长度、1 个 SPS、0 个 PPS。 */
function avcC(sps: Uint8Array): Uint8Array {
  return new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 0]);
}

/** 3822149301（`Wardogs Wet Background.tex`）的 hvcC 前 23 字节：Main、兼容 0x60000000、约束 0x90、level 153。 */
const HVCC_3822149301 = hex("01016000000090000000000099f000fdfdf8f800000f03");
/** ffmpeg + libx265 现编（`testsrc=size=640x360`、`-tag:v hvc1`）的 hvcC 前 23 字节：level 63。 */
const HVCC_X265_360P = hex("0101600000009000000000003ff000fcfdf8f800000f04");

function track(over: Partial<VideoTrackIndex> & { sps?: Uint8Array }): VideoTrackIndex {
  const { sps, ...rest } = over;
  return {
    codec: "avc",
    sampleEntry: "avc1",
    description: avcC(sps ?? SPS_BASELINE),
    codedWidth: 1920,
    codedHeight: 1080,
    timescale: 15360,
    duration: 1,
    offsets: new Float64Array(0),
    sizes: new Uint32Array(0),
    times: new Float64Array(0),
    keys: new Uint8Array(0),
    colr: null,
    editMediaTime: 0,
    ...rest,
  };
}
function colr(matrix: number, fullRange = false, primaries = 1, transfer = 1): Mp4Colr {
  return { primaries, transfer, matrix, fullRange };
}

describe("parseAvcSps：读到 VUI（裁剪后的宽高核对前面的字段都读对了）", () => {
  it.each<[string, Uint8Array, object]>([
    [
      "语料 1080p High，VUI 标 bt709",
      SPS_1080_BT709,
      { profileIdc: 100, width: 1920, height: 1080, vui: { fullRange: false, primaries: 1, transfer: 1, matrix: 1 } },
    ],
    [
      "语料 540p，含防竞争字节，VUI 矩阵 5",
      SPS_540_BT470BG,
      { profileIdc: 100, width: 960, height: 540, vui: { fullRange: false, primaries: 2, transfer: 2, matrix: 5 } },
    ],
    [
      "AVC-Intra 100：4:2:2、SPS 带 scaling list，VUI 矩阵 5",
      SPS_AVCI100,
      {
        profileIdc: 122,
        chromaFormatIdc: 2,
        width: 1920,
        height: 1080,
        vui: { fullRange: false, primaries: 1, transfer: 1, matrix: 5 },
      },
    ],
    [
      "AVC-Intra 50：4:2:0 10 位、SPS 带 scaling list，VUI 没有颜色",
      SPS_AVCI50,
      { profileIdc: 110, chromaFormatIdc: 1, width: 1440, height: 1080, vui: {} },
    ],
    [
      "libx264 320×180：裁剪，VUI full 范围、矩阵 6",
      SPS_180_FULL,
      { width: 320, height: 180, vui: { fullRange: true, primaries: 1, transfer: 1, matrix: 6 } },
    ],
    [
      "libx264 Baseline：没有 High 系字段",
      SPS_BASELINE,
      { profileIdc: 66, chromaFormatIdc: 1, width: 320, height: 240, vui: {} },
    ],
  ])("真实 SPS：%s", (_, sps, expected) => {
    expect(parseAvcSps(sps)).toMatchObject(expected);
  });

  it("合成：4:4:4 的 12 个 scaling list（含 8×8、提前到 0 的「用缺省」表），之后 VUI 矩阵 9", () => {
    const eightByEight = Array.from({ length: 64 }, (_, i) => (i % 3) - 1);
    const sps = synthSps({
      profile: 244,
      chromaFormat: 3,
      scalingLists: [
        [-8],
        [3, 4, -15],
        null,
        null,
        [5, -13],
        null,
        eightByEight,
        null,
        [-8],
        eightByEight,
        null,
        [100, -108],
      ],
      widthMbs: 120,
      heightMapUnits: 68,
      crop: [0, 0, 0, 8],
      vui: { signal: { fullRange: false, colour: [9, 16, 9] } },
    });
    expect(parseAvcSps(sps)).toEqual({
      profileIdc: 244,
      levelIdc: 40,
      chromaFormatIdc: 3,
      // 4:4:4 的裁剪单位是 1
      width: 1920,
      height: 1080,
      vui: { fullRange: false, primaries: 9, transfer: 16, matrix: 9 },
    });
  });

  it("合成：pic_order_cnt_type 1、场编码（纵向裁剪单位 ×2）、扩展 SAR、overscan、只有范围没有颜色描述", () => {
    const sps = synthSps({
      profile: 100,
      pocType: 1,
      widthMbs: 45,
      heightMapUnits: 17,
      frameMbsOnly: false,
      crop: [0, 0, 0, 2],
      vui: { aspect: [4, 3], overscan: true, signal: { fullRange: true } },
    });
    // 720 × (2 × 17 × 16 − 2 × 2 × 2) = 720 × 536
    expect(parseAvcSps(sps)).toMatchObject({ width: 720, height: 536, vui: { fullRange: true } });
    expect(parseAvcSps(sps).vui).toEqual({ fullRange: true });
  });

  it("合成：普通 aspect_ratio_idc、没有 VUI", () => {
    const aspect = synthSps({
      profile: 77,
      widthMbs: 40,
      heightMapUnits: 30,
      vui: { aspect: 1, signal: { fullRange: false, colour: [1, 1, 6] } },
    });
    expect(parseAvcSps(aspect).vui).toEqual({ fullRange: false, primaries: 1, transfer: 1, matrix: 6 });
    const none = synthSps({ profile: 77, widthMbs: 40, heightMapUnits: 30, vui: null });
    expect(parseAvcSps(none)).toMatchObject({ width: 640, height: 480, vui: null });
  });

  it("截断、不是 SPS：抛错", () => {
    expect(() => parseAvcSps(SPS_1080_BT709.subarray(0, 12))).toThrow(/截断/);
    expect(() => parseAvcSps(new Uint8Array([0x68, 0xeb, 0xe3, 0xcb]))).toThrow(/不是 SPS/);
  });

  it("unescapeRbsp：只去掉两个 0 之后的 03", () => {
    expect(Array.from(unescapeRbsp(new Uint8Array([0, 0, 3, 1, 0, 3, 0, 0, 3, 0, 0, 3])))).toEqual([
      0, 0, 1, 0, 3, 0, 0, 0, 0,
    ]);
  });

  it("firstAvcSps：取 avcC 里第一个 SPS；没有或长度越界时 null", () => {
    expect(firstAvcSps(avcC(SPS_1080_BT709))).toEqual(SPS_1080_BT709);
    expect(firstAvcSps(new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]))).toBeNull();
    expect(firstAvcSps(avcC(SPS_1080_BT709).subarray(0, 20))).toBeNull();
  });
});

describe("wpeColor：照 WPE（Media Foundation）", () => {
  it("矩阵码映射：1 → bt709，5 / 6 → smpte170m，9 → bt2020-ncl，其它不认识", () => {
    expect([1, 5, 6, 9].map(matrixFromCode)).toEqual(["bt709", "smpte170m", "smpte170m", "bt2020-ncl"]);
    expect([0, 2, 4, 7, 10, 14].map(matrixFromCode)).toEqual([null, null, null, null, null, null]);
  });

  it("VUI：语料 3400241651（码流标 bt470bg）→ smpte170m / limited", () => {
    const color = wpeColor(track({ sps: SPS_540_BT470BG, codedWidth: 960, codedHeight: 540 }));
    expect(color.colorSpace).toEqual({ primaries: "bt709", transfer: "bt709", matrix: "smpte170m", fullRange: false });
    expect(color).toMatchObject({ source: "vui", code: 5, unknownCode: false, rangeSource: "vui" });
    expect(color.note).toMatch(/SPS VUI 矩阵码 5 → smpte170m/);
  });

  it("VUI：高清片标 bt470bg 也照码流（语料 3812007032 是 4K、标 bt470bg）", () => {
    expect(wpeColorSpace(track({ sps: SPS_540_BT470BG, codedWidth: 3840, codedHeight: 2160 })).matrix).toBe(
      "smpte170m",
    );
  });

  it("colr 优先于 VUI，范围也取 colr；原色与传递函数恒为 bt709", () => {
    const color = wpeColor(track({ sps: SPS_540_BT470BG, colr: colr(1, true, 9, 16) }));
    expect(color.colorSpace).toEqual({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: true });
    expect(color).toMatchObject({ source: "colr", code: 1, rangeSource: "colr" });
  });

  it("colr 矩阵 2（未指定）：往下取 VUI；范围仍取 colr", () => {
    const color = wpeColor(track({ sps: SPS_540_BT470BG, colr: colr(2, true) }));
    expect(color).toMatchObject({ source: "vui", matrix: "smpte170m", rangeSource: "colr" });
    expect(color.colorSpace.fullRange).toBe(true);
  });

  it("colr 矩阵 9 → bt2020-ncl；不认识的码按 bt709 并记下", () => {
    expect(wpeColor(track({ colr: colr(9) })).colorSpace.matrix).toBe("bt2020-ncl");
    const unknown = wpeColor(track({ colr: colr(4), codedHeight: 480 }));
    expect(unknown).toMatchObject({ matrix: "bt709", source: "colr", code: 4, unknownCode: true });
    expect(unknown.note).toMatch(/矩阵码 4 不认识/);
  });

  it(`没标：按分辨率（高 ≥ ${MF_HD_MIN_HEIGHT} 用 bt709，否则 smpte170m）`, () => {
    expect(MF_HD_MIN_HEIGHT).toBe(720);
    const sd = wpeColor(track({ codedWidth: 1280, codedHeight: 719 }));
    expect(sd).toMatchObject({ source: "resolution", code: null, matrix: "smpte170m", rangeSource: "default" });
    expect(sd.colorSpace.fullRange).toBe(false);
    expect(wpeColor(track({ codedWidth: 1280, codedHeight: 720 })).matrix).toBe("bt709");
    // VUI 的矩阵码 2（未指定）同样当作没标
    const unspecified = synthSps({
      profile: 77,
      widthMbs: 20,
      heightMapUnits: 15,
      vui: { signal: { fullRange: false, colour: [2, 2, 2] } },
    });
    expect(wpeColor(track({ sps: unspecified, codedHeight: 240 }))).toMatchObject({
      source: "resolution",
      matrix: "smpte170m",
    });
  });

  it("VUI 没有 video_signal_type（AVC-Intra 50）：矩阵按分辨率、范围未标；只有范围没有颜色描述：范围取 VUI", () => {
    const color = wpeColor(track({ sps: SPS_AVCI50, codedHeight: 480 }));
    expect(color).toMatchObject({ source: "resolution", matrix: "smpte170m", rangeSource: "default" });
    const full = synthSps({ profile: 100, widthMbs: 40, heightMapUnits: 30, vui: { signal: { fullRange: true } } });
    expect(wpeColor(track({ sps: full, codedHeight: 480 })).colorSpace).toMatchObject({
      matrix: "smpte170m",
      fullRange: true,
    });
  });

  it("HEVC 先只认 colr：没有就按分辨率（语料 3822149301 是 1440p → bt709）", () => {
    const hevc = track({
      codec: "hevc",
      sampleEntry: "hvc1",
      description: HVCC_3822149301,
      codedWidth: 2560,
      codedHeight: 1440,
    });
    expect(wpeColor(hevc)).toMatchObject({ source: "resolution", matrix: "bt709" });
    expect(wpeColor({ ...hevc, colr: colr(6) })).toMatchObject({ source: "colr", matrix: "smpte170m" });
  });

  it("SPS 解析失败或 avcC 里没有 SPS：按分辨率，原因进说明", () => {
    const broken = wpeColor(track({ sps: SPS_1080_BT709.subarray(0, 12), codedHeight: 1080 }));
    expect(broken).toMatchObject({ source: "resolution", matrix: "bt709" });
    expect(broken.spsError).toMatch(/截断/);
    expect(broken.note).toMatch(/SPS 解析失败/);
    const empty = wpeColor(track({ description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]), codedHeight: 360 }));
    expect(empty).toMatchObject({ source: "resolution", matrix: "smpte170m", spsError: "avcC 里没有 SPS" });
  });
});

describe("codecString / decoderConfig", () => {
  it("H.264：avcC 第 1–3 字节，前缀照样本项", () => {
    expect(codecString(track({ sps: SPS_1080_BT709 }))).toBe("avc1.640028");
    expect(codecString(track({ sps: SPS_BASELINE, sampleEntry: "avc3" }))).toBe("avc3.42c00d");
  });

  it("H.265：语料 3822149301 → hvc1.1.6.L153.90（步骤 0 在 Chromium 里实测可用）", () => {
    const hevc = track({ codec: "hevc", sampleEntry: "hvc1", description: HVCC_3822149301 });
    expect(codecString(hevc)).toBe("hvc1.1.6.L153.90");
    expect(codecString({ ...hevc, description: HVCC_X265_360P })).toBe("hvc1.1.6.L63.90");
  });

  it("H.265：profile_space 字母、高 tier、兼容标志按位反序、约束字节去掉末尾的 0", () => {
    // space 2（B）、tier 1、profile 2；兼容 0x20000000（第 2 位）反序 → 0x4；约束 b0 00 12 00 00 00；level 186
    const config = hex(["01", "a2", "20000000", "b00012000000", "ba", "f000fdfdf8f800000f03"].join(""));
    const hevc = track({ codec: "hevc", sampleEntry: "hev1", description: config });
    expect(codecString(hevc)).toBe("hev1.B2.4.H186.b0.0.12");
    // 约束全 0：没有尾巴；兼容只有最低位 → 反序后是最高位（按无符号）
    config.set([0, 0, 0, 1, 0, 0, 0, 0, 0, 0], 2);
    expect(codecString(hevc)).toBe("hev1.B2.80000000.H186");
  });

  it("decoderConfig：codec、编码尺寸、description、色彩空间、优先硬件", () => {
    const t = track({ sps: SPS_540_BT470BG, codedWidth: 960, codedHeight: 540 });
    expect(decoderConfig(t)).toEqual({
      codec: "avc1.64001f",
      codedWidth: 960,
      codedHeight: 540,
      description: t.description,
      colorSpace: { primaries: "bt709", transfer: "bt709", matrix: "smpte170m", fullRange: false },
      hardwareAcceleration: "prefer-hardware",
    });
    expect(decoderConfig(t).description).toBe(t.description);
  });
});
