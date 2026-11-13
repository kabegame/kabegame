/**
 * 一次绘制写哪些通道（P8 步骤 5，rea-p8-render 第 4、5 节，p8-REPORT 结论 10、11、`p8-misc` 的 W1 / W2）：写不写 alpha、开不开
 * alpha-to-coverage。两条规则都是纯函数，`scene.ts` 的 `stepPipeline` 在按目标、组与上屏角色算出的缺省值上叠材质的取值；丢弃片元的
 * 着色器入口见 `programs.ts` 的 `alphaToCoverageEntry`。
 */
import type { AlphaWriting } from "../compile/writeState";

export type { AlphaWriting };

/**
 * 一次绘制写不写 alpha（rea-p8-render 4.4 的表，p8-REPORT 结论 10、`p8-misc` W1）。`base` 是 `stepPipeline` 按目标、组与上屏角色算的
 * 缺省值；上屏角色不看材质（绑定后被强制改回）；组的 alpha MAX 强制写（状态 0x10 → 0xF）；其余 enabled 写、disabled 不写。
 * - 场景目标直接上屏（`direct`）：缺省 7、`enabled` 0xF、`disabled` 7；
 * - 上屏角色（`final` / `passthrough`）：WPE 绑定材质之后按「是否在 `copybackground: false` 的组里画子层」重设（`0x1401ec61f`），材质的取值
 *   不起作用，就是 `base`；
 * - 合成 RT 的基础 pass、effect 中间 pass（合成 RT / fbo）：缺省 0xF、`enabled` 0xF、`disabled` 7；
 * - `copybackground: false` 的组里画子层：一律 0xF（`0x10` 强制，`disabled` 也写）。
 * 粒子、网格、文本步骤同一条规则（文本材质是 WPE 自带的，没有这个字段）。
 */
export function writesAlpha(
  base: boolean,
  options: { upload: boolean; alphaMax: boolean; alphaWriting?: AlphaWriting },
): boolean {
  if (options.alphaMax) return true;
  if (options.upload || options.alphaWriting === undefined) return base;
  return options.alphaWriting === "enabled";
}

/**
 * 这一步开不开 alpha-to-coverage（rea-p8-render 第 5 节）：步骤的实际混合是 `alphatocoverage`，包括借了基础材质混合的上屏 pass 与
 * passthrough，以及粒子、网格。画进合成 RT 的基础 pass 混合是 null，不开（WPE 绑定后改回混合 0，`p8-misc` W2），写的是锐化后的 RGBA。
 * 混合状态（关混合）与深度写（同 normal）不用另管：`programs.ts` 的 `blendState` 对它返回「不混合」，`graph.ts` 的 `rasterState` 已按
 * normal 算深度写。
 */
export function alphaToCoverage(blending: string | null): boolean {
  return blending === "alphatocoverage";
}
