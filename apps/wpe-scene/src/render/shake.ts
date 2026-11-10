/**
 * 相机抖动（P5a 步骤 3）：每帧一次的 eye 偏移 s，只由本帧的 `g_Time` 与四个 `camerashake*` 字段决定，没有随机源、没有跨帧状态。
 * 纯函数，不碰 GPU。
 *
 * 公式照读码（rea-p5-camera.md 第 5 节，`FUN_140199580`），2026-11-10 对 WPE 实测（p5-REPORT「P5a 语义的实测核对」，5 组各 4 帧，
 * `g_EyePosition` 的偏移与公式差 ≤ 1e-4）：
 * - `e = powf(roughness, 3)`，`amp = amplitude × 0.1`，`T = speed² × g_Time`（场景时间，已回绕）；
 * - `v = (cos T, sin(1.333·T), sin T)`；正交时 `v.z = 0`、`amp = H × 0.1 × amp`，即 `0.01·amplitude·H` 个场景像素；
 * - `0.001 < e` 且 `e ≠ 1` 时把 v 的长度 L 换成 `L^e`、方向不变（`roughness 2` 改了长度，`0.05` 不改）；
 * - `s = v·amp`，eye 与 center 加同一个 s（纯平移，不转动），在 lookAt 与视差点之前。
 *
 * **按 float32 逐步取整**（`Math.fround`）：`roughness 0.1` 时 `powf(0.1f, 3)` 正好等于 `0.001f`，「`e > 0.001`」为假、不改长度，
 * 按 double 算会进改长度的分支，偏移差约 2.5 像素（p5-REPORT 同节「`roughness 0.1` 的临界值」）。比较的常量也是 `0.001f`：
 * 和 double 的 0.001 比，`0.001f` 大于它，同样会改长度、对不上实测。其余几步照 WPE 的 float 取整，差别只在 `g_Time` 很大时才
 * 显出来。乘法的先后照读码的写法，没有逐条核对汇编，差别在 float 舍入以内。
 *
 * 只有正交：透视下幅度是 `0.1·amplitude` 个世界单位、偏移是三维的，要和透视相机一起做（P5d），能力表在透视场景照报
 * `general:camerashake`。
 *
 * 渲染器在帧开头（视差点、粒子与脚本之前）用本帧的 `g_Time` 和脚本之前的字段算 s，同一个 s 作视差点的 eye（`parallax.ts`），脚本写
 * `camerashake*` 下一帧才生效，同 WPE（rea-p5-camera.md 第 5 节：WPE 更新相机在脚本之前）。s 在粒子步进之后才交给
 * `GpuScene.setCamera`（和 `general.zoom` 一起，P5a 步骤 4）：WPE 先更新对象（粒子模拟）、后更新相机，模拟的指针反投影用上一帧的 s（`p5a-shakepar` 实测，见
 * `SceneRenderer.render`）。dev 探针回放按每帧的 `g_Time` 现算，不用推进。
 */
import type { GeneralValues } from "../compile/bindings";

/** 抖动用到的四个 general 字段（`SceneState.general` 满足）。 */
export type ShakeFields = Pick<
  GeneralValues,
  "camerashake" | "camerashakespeed" | "camerashakeamplitude" | "camerashakeroughness"
>;

const f = Math.fround;
const F_TENTH = f(0.1);
/** 「`e > 0.001`」的常量是 float 的 0.001（见文件头）。 */
const F_THRESHOLD = f(0.001);
const F_Y_RATE = f(1.333);

/**
 * 正交场景一帧的抖动偏移 s（场景单位，加到 eye 与 center 上）；关着时 (0, 0)。`time` 是本帧的 `g_Time`，`height` 是场景的正交
 * 高 H（`SceneGeneral.height`，不是可能被缩小的渲染目标）。按 WPE 的 float 逐步取整：
 * e = powf(roughness, 3)；amp = 0.01·amplitude·H；T = speed²·time；v = (cos T, sin(1.333·T))（正交时 z 清零）；
 * 0.001f < e 且 e ≠ 1 时把 v 的长度 L 换成 L^e、方向不变；s = v·amp。
 * L 为 0 时（cos T 与 sin 1.333T 同时为 0，float 下碰不到）不改长度，WPE 这里会除出 NaN。
 */
export function shakeOffset(fields: ShakeFields, time: number, height: number): [number, number] {
  if (!fields.camerashake) return [0, 0];
  const e = f(Math.pow(f(fields.camerashakeroughness), 3));
  const amp = f(f(f(height) * F_TENTH) * f(f(fields.camerashakeamplitude) * F_TENTH));
  const speed = f(fields.camerashakespeed);
  const t = f(f(speed * speed) * f(time));
  let x = f(Math.cos(t));
  let y = f(Math.sin(f(F_Y_RATE * t)));
  if (e > F_THRESHOLD && e !== 1) {
    const length = f(Math.sqrt(f(f(x * x) + f(y * y))));
    if (length > 0) {
      const scale = f(Math.pow(length, e));
      x = f(f(x / length) * scale);
      y = f(f(y / length) * scale);
    }
  }
  return [f(x * amp), f(y * amp)];
}
