/**
 * PNG 的 `gAMA` 校正（P11b 步骤 2，p11-REPORT M9、rea-p11b R7）。
 *
 * FreeImage（libpng）读 PNG 时按 `png_set_gamma(2.2, 文件 gamma)` 改写像素，浏览器的 `createImageBitmap` 不做，所以宿主自己读 `gAMA` 块：
 * `|2.2·g − 1| ≥ 0.05` 时给一张 8 位表 `t[i] = floor(255·(i/255)^(1/(2.2·g)) + 0.5)`，对 RGB 查表、alpha 不动；否则不校正。
 * 没有 `gAMA` 不校正；有 `sRGB` 块时 libpng 取 0.45455（`2.2·g ≈ 1`），同样不校正（实测 M9：1/2.2 与没有 `gAMA` 时像素不变）。
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 不校正的阈值：`|2.2·g − 1|` 小于它。 */
const GAMMA_TOLERANCE = 0.05;

/**
 * 文件里的 gamma（`gAMA` 块，4 字节大端 × 1e-5）；不是 PNG、没有 `gAMA`、先出现 `sRGB`（libpng 此时忽略 `gAMA`）或只读到 `IDAT`
 * 都返回 null。块按文件顺序走，`gAMA` 必须在 `IDAT` 之前。
 */
export function pngGamma(bytes: Uint8Array): number | null {
  if (bytes.length < 8 || SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let gamma: number | null = null;
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "sRGB") return null;
    if (type === "gAMA" && length === 4 && at + 12 <= bytes.length) gamma = view.getUint32(at + 8) * 1e-5;
    at += 12 + length;
  }
  return gamma;
}

/** 文件 gamma 对应的 8 位校正表；`|2.2·g − 1| < 0.05`（含 `g` 不是正数）时 null。 */
export function gammaTable(gamma: number): Uint8Array | null {
  if (!(gamma > 0) || Math.abs(2.2 * gamma - 1) < GAMMA_TOLERANCE) return null;
  const exponent = 1 / (2.2 * gamma);
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = Math.floor(255 * Math.pow(i / 255, exponent) + 0.5);
  return table;
}

/** 这份文件字节要用的校正表；不是 PNG、没有 `gAMA`、不需要校正时 null。 */
export function pngGammaTable(bytes: Uint8Array): Uint8Array | null {
  const gamma = pngGamma(bytes);
  return gamma === null ? null : gammaTable(gamma);
}

/** 对 RGBA 像素的 RGB 通道查表，alpha 不动（原地改）。 */
export function applyGammaTable(pixels: Uint8ClampedArray | Uint8Array, table: Uint8Array): void {
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    pixels[i] = table[pixels[i]];
    pixels[i + 1] = table[pixels[i + 1]];
    pixels[i + 2] = table[pixels[i + 2]];
  }
}
