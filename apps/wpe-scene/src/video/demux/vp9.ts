/**
 * VP9 码流工具（P9e）：Matroska 的 VP9 轨没有 avcC 那样的解码配置，`CodecPrivate` 可有可无（语料 3662390671 就没有），
 * 解码配置要的 profile、位深、色度采样与颜色都在关键帧的未压缩帧头里。纯函数，Node 里可测。
 *
 * - **帧头**（VP9 码流规范 6.2 `uncompressed_header`）：frame_marker(2) = 2、profile 低位、高位（profile 3 再跟 1 位保留）、
 *   show_existing_frame(1) = 0、frame_type(1) = 0（关键帧）、show_frame(1)、error_resilient_mode(1)、sync code `49 83 42`、
 *   `color_config`（profile ≥ 2 时 1 位定 10 / 12 位，color_space(3)，非 RGB 时 color_range(1)，profile 1 / 3 时再读
 *   subsampling_x / y 与 1 位保留，否则 4:2:0；RGB 时 full range，profile 1 / 3 是 4:4:4 并读 1 位保留，profile 0 / 2 不允许 RGB），
 *   `frame_size`（宽、高各 16 位减 1）。
 * - **level**：codec 串 `vp09.PP.LL.DD` 必须带合法的 level（Chromium 只认表里的值、不按它判断支不支持，P9e 实测 1080p 写 10 也
 *   支持、写 15 不支持）。`CodecPrivate` 的 VP9 codec feature metadata（WebM 规范：ID、长度、值的序列，ID 2 是 level）有就用，
 *   没有就照 VP9 规范附录 A 的表按画面与采样率挑最小的 level（同 libvpx 的算法，最大尺寸等别的约束不看）。
 * - **颜色**：color_space 映射成 ISO/IEC 23091-2 的矩阵码，同 ffmpeg 的 vp9 解码器（`vp9.c` 的 `colorspaces[]`）。
 */

/** 第一个关键帧帧头里解码配置要用的字段，加上 level。 */
export interface Vp9Info {
  /** 0–3。 */
  profile: number;
  /** 8 / 10 / 12。 */
  bitDepth: number;
  /** 1 表示这个方向上色度减半（4:2:0 为 1 / 1，4:2:2 为 1 / 0，4:4:4 为 0 / 0）。 */
  subsamplingX: number;
  subsamplingY: number;
  /** 帧头的 color_space：0 未知、1 BT.601、2 BT.709、3 SMPTE 170、4 SMPTE 240、5 BT.2020、6 保留、7 RGB。 */
  colorSpace: number;
  fullRange: boolean;
  /** 帧头的画面尺寸（frame_width_minus_1 + 1 等）。 */
  width: number;
  height: number;
  /** codec 串里的 level（10 = 1.0 … 62 = 6.2）。 */
  level: number;
  /** level 从哪里来：`CodecPrivate`，或按表算。 */
  levelSource: "codecprivate" | "table";
}

export type Vp9KeyFrame = Omit<Vp9Info, "level" | "levelSource">;

/** VP9 规范附录 A：level、最大亮度采样率（每秒）、最大亮度画面（像素），从小到大。 */
export const VP9_LEVELS: readonly (readonly [level: number, sampleRate: number, pictureSize: number])[] = [
  [10, 829_440, 36_864],
  [11, 2_764_800, 73_728],
  [20, 4_608_000, 122_880],
  [21, 9_216_000, 245_760],
  [30, 20_736_000, 552_960],
  [31, 36_864_000, 983_040],
  [40, 83_558_400, 2_228_224],
  [41, 160_432_128, 2_228_224],
  [50, 311_951_360, 8_912_896],
  [51, 588_251_136, 8_912_896],
  [52, 1_176_502_272, 8_912_896],
  [60, 1_176_502_272, 35_651_584],
  [61, 2_353_004_544, 35_651_584],
  [62, 4_706_009_088, 35_651_584],
];

const VALID_LEVELS = new Set(VP9_LEVELS.map(([level]) => level));
/** 超出表的画面或采样率：取最大的 level（只为 codec 串合法，Chromium 不按它判断）。 */
const MAX_LEVEL = 62;
const SYNC_CODE = [0x49, 0x83, 0x42];
const CS_RGB = 7;

/** 按位读（大端、高位在前），越界时抛错。 */
class Bits {
  private readonly bytes: Uint8Array;
  private bit = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const index = this.bit >> 3;
      if (index >= this.bytes.length) throw new Error(`帧头被截断（${this.bytes.length} 字节）`);
      value = value * 2 + ((this.bytes[index] >> (7 - (this.bit & 7))) & 1);
      this.bit++;
    }
    return value;
  }
}

/** 解析关键帧的未压缩帧头；不是关键帧、sync code 不对、保留位非 0、截断时抛错（中文原因）。 */
export function parseVp9KeyFrame(bytes: Uint8Array): Vp9KeyFrame {
  const bits = new Bits(bytes);
  if (bits.u(2) !== 2) throw new Error("frame_marker 不是 2");
  const low = bits.u(1);
  const high = bits.u(1);
  const profile = (high << 1) | low;
  if (profile === 3 && bits.u(1) !== 0) throw new Error("profile 3 的保留位不是 0");
  if (bits.u(1) === 1) throw new Error("是 show_existing_frame，不是关键帧");
  if (bits.u(1) !== 0) throw new Error("frame_type 不是关键帧");
  bits.u(1); // show_frame
  bits.u(1); // error_resilient_mode
  for (const byte of SYNC_CODE) {
    if (bits.u(8) !== byte) throw new Error("frame_sync_code 不对");
  }
  // color_config
  const bitDepth = profile >= 2 ? (bits.u(1) ? 12 : 10) : 8;
  const colorSpace = bits.u(3);
  let fullRange: boolean;
  let subsamplingX = 1;
  let subsamplingY = 1;
  if (colorSpace !== CS_RGB) {
    fullRange = bits.u(1) === 1;
    if (profile === 1 || profile === 3) {
      subsamplingX = bits.u(1);
      subsamplingY = bits.u(1);
      if (bits.u(1) !== 0) throw new Error("color_config 的保留位不是 0");
    }
  } else {
    fullRange = true;
    if (profile !== 1 && profile !== 3) throw new Error(`profile ${profile} 不允许 RGB`);
    subsamplingX = 0;
    subsamplingY = 0;
    if (bits.u(1) !== 0) throw new Error("color_config 的保留位不是 0");
  }
  // frame_size
  const width = bits.u(16) + 1;
  const height = bits.u(16) + 1;
  return { profile, bitDepth, subsamplingX, subsamplingY, colorSpace, fullRange, width, height };
}

/** `CodecPrivate` 的 VP9 codec feature metadata（ID(1) 长度(1) 值）里的 level（ID 2，长度 1）；没有、不合法或畸形为 null。 */
export function vp9CodecPrivateLevel(bytes: Uint8Array): number | null {
  for (let at = 0; at + 2 <= bytes.length;) {
    const id = bytes[at];
    const length = bytes[at + 1];
    if (at + 2 + length > bytes.length) return null;
    if (id === 2 && length === 1) return VALID_LEVELS.has(bytes[at + 2]) ? bytes[at + 2] : null;
    at += 2 + length;
  }
  return null;
}

/** 能容纳「宽 × 高」与「宽 × 高 × 帧率」的最小 level；帧率未知（null、非正、非有限）时只看画面；都超出取 62。 */
export function vp9Level(width: number, height: number, fps: number | null): number {
  const picture = width * height;
  const rate = fps !== null && Number.isFinite(fps) && fps > 0 ? picture * fps : 0;
  for (const [level, sampleRate, pictureSize] of VP9_LEVELS) {
    if (picture <= pictureSize && rate <= sampleRate) return level;
  }
  return MAX_LEVEL;
}

/** color_space → ISO/IEC 23091-2 矩阵码（同 ffmpeg 的 vp9 解码器）：未知与保留为 2（未指定），RGB 为 0（identity）。 */
export function vp9MatrixCode(colorSpace: number): number {
  return [2, 5, 1, 6, 7, 9, 2, 0][colorSpace] ?? 2;
}
