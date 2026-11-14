/**
 * WebCodecs 的解码配置（P9d 步骤 1 点 2）：codec 串、`description` 与色彩空间，交给 `VideoDecoder.configure`。
 *
 * - **codec 串**：H.264 是 `<样本项>.PPCCLL`（avcC 第 1–3 字节，各两位十六进制）；H.265 照 ISO/IEC 14496-15 附录 E：
 *   `<样本项>.<profile_space 字母><profile_idc>.<兼容标志按位反序的十六进制>.<L|H><level_idc>.<约束字节>`，约束字节 6 个、
 *   去掉末尾的 0 之后各自十六进制用 `.` 连接（步骤 0 实测 3822149301 为 `hvc1.1.6.L153.90`）。前缀照样本项（avc1 / avc3 /
 *   hvc1 / hev1），十六进制用小写（步骤 0 在 Chromium 里实测过的写法）。
 * - **颜色照 WPE（Media Foundation）**：步骤 0 实测 WebCodecs 不读码流的色彩标签、缺省一律按 BT.709，所以必须自己给。矩阵依次取
 *   `colr` 盒 → H.264 SPS 的 VUI → 没标时按分辨率（MF 的 SD / HD 规则，阈值 `MF_HD_MIN_HEIGHT`，步骤 4 用 WPE 实测分界）；
 *   码值 2（未指定）当作没标、往下一个来源找。原色与传递函数恒报 bt709，即不做色域与传递函数转换（WPE 不做，phase-9c
 *   「步骤 3」）；范围取 `colr` 的 full_range，没有 `colr` 时取 VUI 的 video_full_range_flag，都没有为 false（limited）。
 *   HEVC 先只认 `colr`（语料唯一的 HEVC 是 1440p，按分辨率给 709，和它码流的标签一致），HEVC 的 VUI 等需要时再解。
 * - **SPS**：avcC 里第一个 SPS，去掉防竞争字节（`00 00 03` 里的 03）后按 exp-Golomb 读到 `vui_parameters`，High 系 profile 的
 *   chroma_format_idc、bit depth 与 scaling list 照 ITU-T H.264 7.3.2.1.1 跳过；顺带算出裁剪后的宽高（语料扫描用它核对解析走对了）。
 *
 * `track` 由 `indexMp4` 给出，avcC / hvcC 的长度已在那边检查过，这里的函数不抛错（SPS 解析失败时退到分辨率规则，原因进说明）。
 */
import type { VideoTrackIndex } from "./mp4";

/** Media Foundation 没有色彩标签时按分辨率选矩阵：编码高度 ≥ 这个值用 BT.709，否则 BT.601（smpte170m）。 */
export const MF_HD_MIN_HEIGHT = 720;

/** WebCodecs 的矩阵名；TS 的 DOM 类型里还没有 `bt2020-ncl`（Chromium 认）。 */
export type WpeMatrix = VideoMatrixCoefficients | "bt2020-ncl";

/** 矩阵从哪里来：`colr` 盒、H.264 SPS 的 VUI、没标时的分辨率规则。 */
export type ColorSource = "colr" | "vui" | "resolution";

export interface WpeColor {
  colorSpace: VideoColorSpaceInit;
  matrix: WpeMatrix;
  source: ColorSource;
  /** 来源里的矩阵码（ISO/IEC 23091-2）；按分辨率时 null。 */
  code: number | null;
  /** 码值不在映射表里、按 bt709 处理。 */
  unknownCode: boolean;
  /** 范围从哪里来：`colr`、VUI 的 video_signal_type，或都没有（false）。 */
  rangeSource: "colr" | "vui" | "default";
  /** SPS 解析失败的原因（有 VUI 也读不出来），没有为 undefined。 */
  spsError?: string;
  /** 一句话的色彩来源说明，日志与语料扫描用。 */
  note: string;
}

/** codec 串、description、色彩空间：交给 VideoDecoder.configure。 */
export function decoderConfig(track: VideoTrackIndex): VideoDecoderConfig {
  return {
    codec: codecString(track),
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    description: track.description,
    colorSpace: wpeColorSpace(track),
    hardwareAcceleration: "prefer-hardware",
  };
}

/** 照 WPE（Media Foundation）的颜色：矩阵取 colr → H.264 SPS VUI → 没标时按分辨率，原色与传递函数恒为 bt709，范围取码流的。 */
export function wpeColorSpace(track: VideoTrackIndex): VideoColorSpaceInit {
  return wpeColor(track).colorSpace;
}

/** 矩阵码 → WebCodecs 的矩阵名：1 → bt709，5 / 6 → smpte170m（bt470bg 与它同一个矩阵），9 → bt2020-ncl，其它 null。 */
export function matrixFromCode(code: number): WpeMatrix | null {
  if (code === 1) return "bt709";
  if (code === 5 || code === 6) return "smpte170m";
  if (code === 9) return "bt2020-ncl";
  return null;
}

/** `wpeColorSpace` 的完整结论：结果、矩阵与范围的来源、说明。 */
export function wpeColor(track: VideoTrackIndex): WpeColor {
  let vui: AvcVui | null = null;
  let spsError: string | undefined;
  if (track.codec === "avc") {
    const sps = firstAvcSps(track.description);
    if (!sps) spsError = "avcC 里没有 SPS";
    else {
      try {
        vui = parseAvcSps(sps).vui;
      } catch (error) {
        spsError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  // 矩阵：第一个标了（码值不是 2「未指定」）的来源
  let source: ColorSource = "resolution";
  let code: number | null = null;
  if (track.colr && track.colr.matrix !== 2) {
    source = "colr";
    code = track.colr.matrix;
  } else if (vui?.matrix !== undefined && vui.matrix !== 2) {
    source = "vui";
    code = vui.matrix;
  }
  const mapped = code === null ? null : matrixFromCode(code);
  const unknownCode = code !== null && mapped === null;
  const matrix: WpeMatrix = mapped ?? (code === null && track.codedHeight < MF_HD_MIN_HEIGHT ? "smpte170m" : "bt709");
  const rangeSource = track.colr ? "colr" : vui?.fullRange !== undefined ? "vui" : "default";
  const fullRange = track.colr ? track.colr.fullRange : (vui?.fullRange ?? false);

  const where = source === "colr" ? "colr" : "SPS VUI";
  let note =
    source === "resolution"
      ? `未标，按分辨率（高 ${track.codedHeight} ${track.codedHeight >= MF_HD_MIN_HEIGHT ? "≥" : "<"} ${MF_HD_MIN_HEIGHT}）→ ${matrix}`
      : unknownCode
        ? `${where} 矩阵码 ${code} 不认识，按 bt709`
        : `${where} 矩阵码 ${code} → ${matrix}`;
  note += `；范围 ${fullRange ? "full" : "limited"}（${rangeSource === "default" ? "未标" : rangeSource === "colr" ? "colr" : "VUI"}）`;
  if (spsError) note += `；SPS 解析失败：${spsError}`;
  return {
    // TS 的 VideoMatrixCoefficients 里没有 bt2020-ncl，Chromium 认（WebCodecs 规范的枚举里有）
    colorSpace: { primaries: "bt709", transfer: "bt709", matrix: matrix as VideoMatrixCoefficients, fullRange },
    matrix,
    source,
    code,
    unknownCode,
    rangeSource,
    ...(spsError !== undefined ? { spsError } : {}),
    note,
  };
}

// ———— codec 串 ————

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** codec 串：`avc1.PPCCLL` / `hvc1.<space><idc>.<compat 反序>.<L|H><level>.<约束>`，前缀照样本项。 */
export function codecString(track: VideoTrackIndex): string {
  const c = track.description;
  if (track.codec === "avc") return `${track.sampleEntry}.${hex2(c[1])}${hex2(c[2])}${hex2(c[3])}`;
  // hvcC：configurationVersion(1)，general_profile_space(2) tier(1) profile_idc(5)，兼容标志(4)，约束(6)，level_idc(1)
  const space = ["", "A", "B", "C"][c[1] >> 6];
  const tier = (c[1] >> 5) & 1 ? "H" : "L";
  const profile = c[1] & 0x1f;
  let flags = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = ((reversed << 1) | (flags & 1)) >>> 0;
    flags >>>= 1;
  }
  const constraints = Array.from(c.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const tail = constraints.map((byte) => `.${byte.toString(16)}`).join("");
  return `${track.sampleEntry}.${space}${profile}.${reversed.toString(16)}.${tier}${c[12]}${tail}`;
}

// ———— H.264 SPS ————

/** VUI 里和颜色有关的字段：没出现的为 undefined。 */
export interface AvcVui {
  /** video_signal_type_present_flag 为 1 时有。 */
  fullRange?: boolean;
  /** colour_description_present_flag 为 1 时有。 */
  primaries?: number;
  transfer?: number;
  matrix?: number;
}

export interface AvcSps {
  profileIdc: number;
  levelIdc: number;
  chromaFormatIdc: number;
  /** 帧裁剪之后的宽高（像素）。 */
  width: number;
  height: number;
  /** vui_parameters_present_flag 为 0 时 null。 */
  vui: AvcVui | null;
}

/** avcC 里第一个 SPS（含 1 字节 NAL 头）：configurationVersion(1) profile(1) compat(1) level(1) lengthSize(1) numSPS(低 5 位)，之后每个 SPS = 长度(2) + 字节。 */
export function firstAvcSps(avcC: Uint8Array): Uint8Array | null {
  if (avcC.length < 8 || (avcC[5] & 0x1f) === 0) return null;
  const size = (avcC[6] << 8) | avcC[7];
  if (size === 0 || 8 + size > avcC.length) return null;
  return avcC.subarray(8, 8 + size);
}

/** 去掉防竞争字节：`00 00 03` 里的 03。 */
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let length = 0;
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[length++] = byte;
  }
  return out.subarray(0, length);
}

/** 按位读（大端、高位在前），越界时抛错。 */
class BitReader {
  private bytes: Uint8Array;
  private bit = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  u1(): number {
    const index = this.bit >> 3;
    if (index >= this.bytes.length) throw new Error("SPS 被截断");
    const value = (this.bytes[index] >> (7 - (this.bit & 7))) & 1;
    this.bit++;
    return value;
  }

  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 2 + this.u1();
    return value;
  }

  /** 无符号 exp-Golomb。 */
  ue(): number {
    let zeros = 0;
    while (this.u1() === 0) {
      if (++zeros > 31) throw new Error("SPS 的 exp-Golomb 前导 0 超过 31 个");
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  /** 有符号 exp-Golomb：1, 2, 3, 4… → 1, -1, 2, -2… */
  se(): number {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/** 带 chroma_format_idc 等扩展字段的 profile（H.264 7.3.2.1.1）。 */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** scaling_list(sizeOfScalingList)：只为跳过，delta_scale 读到 nextScale 为 0 为止。 */
function skipScalingList(bits: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = bits.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

/** 解析 SPS NAL（含 1 字节 NAL 头）到 VUI 的颜色字段；截断或不是 SPS 时抛错。 */
export function parseAvcSps(nal: Uint8Array): AvcSps {
  if (nal.length < 4 || (nal[0] & 0x1f) !== 7) throw new Error("不是 SPS（NAL 类型不是 7）");
  const bits = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profileIdc = bits.u(8);
  bits.u(8); // constraint_set0..5_flag + reserved_zero_2bits
  const levelIdc = bits.u(8);
  bits.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = bits.ue();
    if (chromaFormatIdc === 3) separateColourPlane = bits.u1();
    bits.ue(); // bit_depth_luma_minus8
    bits.ue(); // bit_depth_chroma_minus8
    bits.u1(); // qpprime_y_zero_transform_bypass_flag
    if (bits.u1()) {
      // seq_scaling_matrix_present_flag：4:4:4 时 12 个表，否则 8 个；前 6 个 4×4、之后 8×8
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) if (bits.u1()) skipScalingList(bits, i < 6 ? 16 : 64);
    }
  }
  bits.ue(); // log2_max_frame_num_minus4
  const pocType = bits.ue();
  if (pocType === 0)
    bits.ue(); // log2_max_pic_order_cnt_lsb_minus4
  else if (pocType === 1) {
    bits.u1(); // delta_pic_order_always_zero_flag
    bits.se(); // offset_for_non_ref_pic
    bits.se(); // offset_for_top_to_bottom_field
    const cycle = bits.ue();
    for (let i = 0; i < cycle; i++) bits.se(); // offset_for_ref_frame
  }
  bits.ue(); // max_num_ref_frames
  bits.u1(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = bits.ue() + 1;
  const heightMapUnits = bits.ue() + 1;
  const frameMbsOnly = bits.u1();
  if (!frameMbsOnly) bits.u1(); // mb_adaptive_frame_field_flag
  bits.u1(); // direct_8x8_inference_flag
  let cropLeft = 0,
    cropRight = 0,
    cropTop = 0,
    cropBottom = 0;
  if (bits.u1()) {
    cropLeft = bits.ue();
    cropRight = bits.ue();
    cropTop = bits.ue();
    cropBottom = bits.ue();
  }
  // 裁剪单位（H.264 7.4.2.1.1）：单色或分平面时 1，否则 SubWidthC / SubHeightC；场编码时纵向再乘 2
  const chroma = separateColourPlane ? 0 : chromaFormatIdc;
  const subWidth = chroma === 1 || chroma === 2 ? 2 : 1;
  const subHeight = chroma === 1 ? 2 : 1;
  const width = widthMbs * 16 - subWidth * (cropLeft + cropRight);
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - subHeight * (2 - frameMbsOnly) * (cropTop + cropBottom);

  let vui: AvcVui | null = null;
  if (bits.u1()) {
    vui = {};
    if (bits.u1()) {
      // aspect_ratio_info_present_flag
      if (bits.u(8) === 255) bits.u(32); // Extended_SAR：sar_width(16) sar_height(16)
    }
    if (bits.u1()) bits.u1(); // overscan_info_present_flag → overscan_appropriate_flag
    if (bits.u1()) {
      // video_signal_type_present_flag
      bits.u(3); // video_format
      vui.fullRange = bits.u1() === 1;
      if (bits.u1()) {
        vui.primaries = bits.u(8);
        vui.transfer = bits.u(8);
        vui.matrix = bits.u(8);
      }
    }
  }
  return { profileIdc, levelIdc, chromaFormatIdc, width, height, vui };
}
