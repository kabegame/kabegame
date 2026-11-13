/**
 * 材质 pass 写入状态的编译期部分（P8 步骤 5，rea-p8-render 第 4、5 节，p8-REPORT 结论 10、11）：
 * - `alphawriting`：只把改设备状态的两个取值带进 `ScenePass`（`passAlphaWriting`），渲染器据此定写掩码（`render/writeState.ts`）；
 * - `alphatocoverage`：WPE 绑定时给着色器组合键加 `ALPHATOCOVERAGE = 1`（`materialCombos`），`genericimage4` 等读它把 alpha 锐化成
 *   以 0.5 为中心的阶跃；丢弃片元在渲染器里做（`render/programs.ts` 的 `alphaToCoverageEntry`）。
 */
import type { MaterialPass } from "./model";

/** 材质 pass 的 `alphawriting`（rea-p8-render 4.3）：只有这两个取值改设备状态；`default` 与没写一样，编译期不写进 `ScenePass`。 */
export type AlphaWriting = "enabled" | "disabled";

/**
 * `ScenePass.alphaWriting` 的取值：材质写 `enabled` / `disabled` 时原样带上，其余（缺键、`default`、能力表照报的别的取值）不写这个键，
 * 和加这一项之前的 `ScenePass` 逐字相同。WPE 映射表只有 `default` 0、`enabled` 1、`disabled` 2（`0x140157d60`），绑定时 0 什么都不做。
 */
export function passAlphaWriting(pass: MaterialPass): { alphaWriting?: AlphaWriting } {
  const value = pass.alphawriting;
  return value === "enabled" || value === "disabled" ? { alphaWriting: value } : {};
}

/** A2C 的组合键名（WPE 绑定时加的，`0x1401564a4`–`0x140156508`）；翻译器按大写处理组合键名。 */
export const ALPHA_TO_COVERAGE_COMBO = "ALPHATOCOVERAGE";

/**
 * 编译材质 pass 的着色器时用的组合键（rea-p8-render 5.4）：混合是 `alphatocoverage` 时加 `ALPHATOCOVERAGE = 1`，先去掉名字只是大小写
 * 不同的同名键（翻译器不分大小写，同名两项谁胜不确定）；翻译器对请求里的组合键一律定义，不要求着色器声明。别的混合原样返回材质的
 * `combos`（同一个对象，缺省时空对象），翻译请求与着色器缓存键和改前逐字相同。
 * 组合键只看本 pass 自己的混合：WPE 上屏时把基础材质的混合拷给最后一个 effect pass，组合键可能也带上，但 WPE 自带 effect 与语料的着色器
 * 没有一处读它，加不加结果相同。
 */
export function materialCombos(pass: Pick<MaterialPass, "blending" | "combos">): Record<string, number | boolean> {
  const combos = pass.combos ?? {};
  if (pass.blending !== "alphatocoverage") return combos;
  const out: Record<string, number | boolean> = {};
  for (const [name, value] of Object.entries(combos))
    if (name.toUpperCase() !== ALPHA_TO_COVERAGE_COMBO) out[name] = value;
  out[ALPHA_TO_COVERAGE_COMBO] = 1;
  return out;
}
