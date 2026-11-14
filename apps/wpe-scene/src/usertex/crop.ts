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
