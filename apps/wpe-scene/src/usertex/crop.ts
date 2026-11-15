/**
 * 用户纹理的裁切与缓存键（P11b 步骤 2，rea-p11-textures 2.2 的 `FUN_1401702f0`，p11-REPORT「属性纹理」第 2、8、9 条）。
 *
 * 用户图在源图正中裁出最大的、宽高比等于「参考尺寸」比例的矩形，像素一比一、不缩放。全部纯函数、不碰 GPU：
 * 裁切本身由渲染器在 `copyExternalImageToTexture` 的源矩形上做（`GpuScene`），这里只给矩形与 WPE 的纹理名。
 * 取整全部按 float32 算（WPE 的比例与乘除都是单精度，`5/3` 的比例乘 360 要落在 600 而不是 599）。
 */

/** 源图上的一块矩形（像素）；纹理尺寸就是它的宽高。 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 参考尺寸的比例 a = 宽 / 高（float32）。宽或高不是正数时为 0，等同 `keepaspect`：整张进纹理（`cropRect` 的比例 0）。
 */
export function referenceRatio(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0;
  return Math.fround(Math.fround(width) / Math.fround(height));
}

/**
 * `FUN_1401702f0` 的裁切：`w/h ≤ a` 时高裁成 `trunc(w/a)`、起始行 `(h − h')>>1`；否则宽裁成 `trunc(h·a)`、起始列 `(w − w')>>1`；
 * 比例 0（`keepaspect`、没有参考尺寸）时整张。结果至少 1×1（WPE 对 0 尺寸没有处理，GPU 纹理不能是 0，不可达的边界）。
 */
export function cropRect(width: number, height: number, ratio: number): CropRect {
  if (!(ratio > 0)) return { x: 0, y: 0, width, height };
  const f32 = Math.fround;
  if (f32(f32(width) / f32(height)) <= ratio) {
    const cropped = Math.min(height, Math.max(1, Math.trunc(f32(f32(width) / ratio))));
    return { x: 0, y: (height - cropped) >> 1, width, height: cropped };
  }
  const cropped = Math.min(width, Math.max(1, Math.trunc(f32(f32(height) * ratio))));
  return { x: (width - cropped) >> 1, y: 0, width: cropped, height };
}

/** C 的 `roundf`：四舍五入、半数远离 0。 */
export function roundf(value: number): number {
  return value < 0 ? -Math.floor(-value + 0.5) : Math.floor(value + 0.5);
}

/**
 * WPE 的纹理名（缓存键）：`值 + "x" + round(比例 · 10)`（rea-p11b「顺带」）。比例四舍五入到 0.1 相同的槽共用一张纹理，按先建的那个槽的
 * 精确比例裁；`·10` 是 float32 乘法。
 */
export function textureKey(value: string, ratio: number): string {
  return `${value}x${roundf(Math.fround(Math.fround(ratio) * 10))}`;
}

/**
 * 快捷方式图标补透明边后的尺寸与图标的摆放（P11d，p11-REPORT「P11d 补测」图标纹理）：补到槽的比例 `a`（宽 / 高，float32），居中、不裁切；
 * 取整照 WPE：`(int)` 截断、`>> 1` 居中。`w / h ≤ a` 时宽补到 `trunc(h·a)`、左右各 `(宽' − w) >> 1`，否则高补到 `trunc(w / a)`、上下居中。
 * `a` 为 0（`keepaspect`、没有参考尺寸）时原样。补的边全 0（透明）；算出的边比图标还小（float32 截断的边界）时取图标的边，不裁。
 *
 * 例：256×256 配 2:1 → 512×256、x = 128；配精灵表帧比例 1.66668 → 426×256、x = 85；配 1:4 → 256×1024、y = 384。
 */
export function padRect(w: number, h: number, a: number): CropRect {
  if (!(a > 0)) return { x: 0, y: 0, width: w, height: h };
  const f32 = Math.fround;
  if (f32(f32(w) / f32(h)) <= a) {
    const width = Math.max(w, Math.trunc(f32(f32(h) * a)));
    return { x: (width - w) >> 1, y: 0, width, height: h };
  }
  const height = Math.max(h, Math.trunc(f32(f32(w) / a)));
  return { x: 0, y: (height - h) >> 1, width: w, height };
}
