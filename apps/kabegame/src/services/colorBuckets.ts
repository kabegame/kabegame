import { invoke } from "@/api/rpc";
import { rgbToHex } from "@/utils/palette";

/** 色桶列表的 PathQL 路径：`color_buckets://` 根，按显示顺序返回全部色桶。 */
export const COLOR_BUCKETS_PATH = "color_buckets://";

/** 用户保存的色桶的上限，与后端 `MAX_CUSTOM_COLOR_BUCKETS` 一致；前端只用来提前置灰按钮。 */
export const MAX_CUSTOM_COLOR_BUCKETS = 24;

export interface ColorBucket {
  /** 0xRRGGBB 整数，色桶主键。 */
  rgb: number;
  /** 六位小写十六进制，不带前缀；由 `rgb` 补零转出。 */
  hex: string;
  /** 基本色桶的名称键（`red` 等）；用户保存的色桶为 null。 */
  key: string | null;
  /** 显示顺序。 */
  position: number;
}

const HEX_RE = /^[0-9a-f]{6}$/;

/** `color_buckets://` 的一行 → 色桶；`rgb` 不是 0–0xffffff 的整数时返回 null。 */
export function normalizeColorBucketRow(row: Record<string, unknown>): ColorBucket | null {
  const rgb = typeof row.rgb === "string" && row.rgb.trim() ? Number(row.rgb) : row.rgb;
  if (typeof rgb !== "number" || !Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) return null;
  const position = Number(row.position);
  return {
    rgb,
    hex: rgbToHex(rgb),
    key: typeof row.key === "string" && row.key ? row.key : null,
    position: Number.isFinite(position) ? position : 0,
  };
}

/** 整张表：丢掉坏行，按 `position`（并列按 `rgb`）升序，与后端的顺序一致。 */
export function normalizeColorBucketRows(rows: readonly Record<string, unknown>[]): ColorBucket[] {
  return rows
    .map(normalizeColorBucketRow)
    .filter((bucket): bucket is ColorBucket => bucket !== null)
    .sort((a, b) => a.position - b.position || a.rgb - b.rgb);
}

/** 颜色的各种写法（`#RRGGBB`、`rrggbb`）→ 六位小写十六进制；不是六位十六进制时返回 null。 */
export function normalizeColorHex(value: string | null | undefined): string | null {
  const hex = (value ?? "").trim().replace(/^#/, "").toLowerCase();
  return HEX_RE.test(hex) ? hex : null;
}

// ---------------------------------------------------------------------------
// 写操作：写完不请求任何 key，色桶列表等 `color-buckets-change` 事件重读。
// ---------------------------------------------------------------------------

/** 后端的错误码（`color-bucket:<code>`）。 */
export type ColorBucketErrorCode = "invalid" | "exists" | "limit" | "builtin" | "not-found";

const ERROR_CODES: readonly ColorBucketErrorCode[] = ["invalid", "exists", "limit", "builtin", "not-found"];

/** 各错误码的提示文案键；没有专门文案的归到通用的「操作失败」。 */
const ERROR_MESSAGE_KEYS: Record<ColorBucketErrorCode, string> = {
  invalid: "common.operationFailed",
  exists: "gallery.colorBucketExists",
  limit: "gallery.colorBucketLimit",
  builtin: "common.operationFailed",
  "not-found": "common.operationFailed",
};

/** 色桶写操作失败：`code` 是识别出的错误码（认不出为 null），`messageKey` 是给用户看的 i18n 键。 */
export class ColorBucketError extends Error {
  readonly code: ColorBucketErrorCode | null;
  readonly messageKey: string;

  constructor(raw: string, code: ColorBucketErrorCode | null) {
    super(raw);
    this.name = "ColorBucketError";
    this.code = code;
    this.messageKey = code ? ERROR_MESSAGE_KEYS[code] : "common.operationFailed";
  }
}

/** 从命令的报错里认出错误码：报错是字符串或 Error，码可能带前后文。 */
export function colorBucketErrorCode(error: unknown): ColorBucketErrorCode | null {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  const match = /color-bucket:([a-z-]+)/.exec(text);
  const code = match?.[1] as ColorBucketErrorCode | undefined;
  return code && ERROR_CODES.includes(code) ? code : null;
}

function toColorBucketError(error: unknown): ColorBucketError {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return new ColorBucketError(raw, colorBucketErrorCode(error));
}

function hexToRgb(hex: string): number {
  if (!HEX_RE.test(hex)) throw new ColorBucketError("color-bucket:invalid", "invalid");
  return Number.parseInt(hex, 16);
}

/**
 * 把一个颜色保存成色桶。后端在同一个事务里补算它对全库图片的距离，图库很大时要几秒，
 * 提交后才返回。失败抛 `ColorBucketError`。
 */
export async function addColorBucket(hex: string): Promise<ColorBucket> {
  const rgb = hexToRgb(hex);
  try {
    const row = await invoke<Record<string, unknown>>("add_color_bucket", { rgb });
    // 返回行不合形状时按请求的颜色兜底：调用方只关心「存成了」
    return normalizeColorBucketRow(row ?? {}) ?? { rgb, hex, key: null, position: 0 };
  } catch (error) {
    throw toColorBucketError(error);
  }
}

/**
 * 删一个用户保存的色桶。色桶已经不在了（`not-found`）当作删除成功：结果就是调用方想要的。
 * 其它失败抛 `ColorBucketError`。
 */
export async function deleteColorBucket(hex: string): Promise<void> {
  const rgb = hexToRgb(hex);
  try {
    await invoke("delete_color_bucket", { rgb });
  } catch (error) {
    const wrapped = toColorBucketError(error);
    if (wrapped.code === "not-found") return;
    throw wrapped;
  }
}
