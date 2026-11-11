/** 色盘里的一个代表色。 */
export interface PaletteColor {
  /** 0xRRGGBB 整数。 */
  rgb: number;
  /** 六位小写十六进制，不带前缀。 */
  hex: string;
  /** 面积占比（百分比）。 */
  percent: number;
}

/** rgb 整数 → 六位小写十六进制（黑色是 `000000`）。 */
export function rgbToHex(rgb: number): string {
  return rgb.toString(16).padStart(6, "0");
}

function isRgb(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

function isPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 解析图片行的 `palette` 字段：JSON 文本 `[[rgb, 百分比], …]`。
 * 没有色盘（null / 空串）或不是这个形状时返回空数组——整份作废，不取其中合法的几项。
 */
export function parsePalette(text?: string | null): PaletteColor[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const colors: PaletteColor[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return [];
    const [rgb, percent] = entry as unknown[];
    if (!isRgb(rgb) || !isPercent(percent)) return [];
    colors.push({ rgb, hex: rgbToHex(rgb), percent });
  }
  return colors;
}

/** 颜色是否偏浅：压在它上面的图标 / 文字该用深色。`hex` 是六位十六进制，不带前缀。 */
export function isLightColor(hex: string): boolean {
  const rgb = Number.parseInt(hex, 16);
  if (!Number.isFinite(rgb)) return false;
  const luma = 0.299 * ((rgb >> 16) & 0xff) + 0.587 * ((rgb >> 8) & 0xff) + 0.114 * (rgb & 0xff);
  return luma > 150;
}
