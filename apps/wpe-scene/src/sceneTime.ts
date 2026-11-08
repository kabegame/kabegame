/**
 * 场景时间的公共常量。渲染层（`render/`：`g_Time` uniform）与粒子模拟（`particles/`：噪声类模块的场景时间 `T`）都用，
 * 放在两者之外，`particles/` 不必依赖渲染层（P4a 约定：模拟器纯 TS、离开渲染器可单测）。
 */

/**
 * `g_Time` 超过 5 天（432000 s）归零（p2-REPORT C「时间」）。粒子的场景时间 `T` 与它同源（`ctx+0x130`，
 * `rea-p4b-modules.md`「命名」），按同一个值回绕。
 */
export const TIME_WRAP_SECONDS = 432000;
