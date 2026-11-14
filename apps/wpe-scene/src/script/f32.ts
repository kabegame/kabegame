/**
 * 场景脚本看到的数值按 WPE 取单精度（P3b 补测，`ignore/p3b-f32`，2026-11-14 实测）。
 *
 * WPE 把图层字段、材质常量都存成 float32，交给脚本的是 f32 的值：字段脚本 `init` / `update` 的入参（vec2 / vec3 / float、材质常量）、
 * `thisLayer.<字段>`、从别的图层读的字段、`size`、材质对象 `thisObject.<键>` 都是（`100.1` 读成 `100.0999984741211`）。
 * 我们的 `SceneState` 照旧存 double（存储不动、上传 GPU 时本来就是 f32），只在脚本读取时取单精度：每次读都取一次，
 * 「读 → 改 → 写回」每一轮和 WPE 是同一个值（写进去的 double 下一次读出来就是 WPE 存下的那个 f32），累加不漂移。
 *
 * 角度另有换算：WPE 存弧度（f32），读写都在 f32 里乘一个 f32 常数（两个 f32 的乘积在 double 里是精确的，`Math.fround` 一次就等于
 * f32 乘法）。实测排除了「弧度 / 0.017453292（double）」及其再取 f32、「÷ f32(0.017453292)」「× 180/π（double）」，写回排除了
 * 「f32(度 × 0.017453292)」（double 乘法，`C.api` 第 7 帧起分叉）、「÷ f32(57.29578)」「× π/180（double）」。写回的弧度是 f32 能
 * 精确表示的 double，宿主照常写进状态。
 */

/** WPE 弧度 → 度的常数：f32(57.29578) = f32(1 / 0.017453292) = f32(180 / π) = 57.295780181884766。 */
const F_RAD_TO_DEG = Math.fround(57.29578);
/** WPE 度 → 弧度的常数：f32(0.017453292) = f32(π / 180) = 0.01745329238474369（同 `render/camera.ts` 的 `F_DEG_TO_RAD`）。 */
const F_DEG_TO_RAD = Math.fround(0.017453292);

/** 交给脚本的数：数取 f32，别的原样（布尔、字符串、缺值）。 */
export function scriptNumber<T>(value: T): T | number {
  return typeof value === "number" ? Math.fround(value) : value;
}

/** 交给脚本的向量分量：逐个取 f32。 */
export function scriptNumbers(values: readonly number[]): number[] {
  return values.map((value) => Math.fround(value));
}

/** 状态里的弧度 → 脚本看到的度：`f32(f32(弧度) × f32(57.29578))`。 */
export function radiansToScript(radians: number): number {
  return Math.fround(Math.fround(radians) * F_RAD_TO_DEG);
}

/** 脚本写回的度 → 交给宿主的弧度：`f32(f32(度) × f32(0.017453292))`。 */
export function degreesFromScript(degrees: number): number {
  return Math.fround(Math.fround(degrees) * F_DEG_TO_RAD);
}
