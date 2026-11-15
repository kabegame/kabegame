/**
 * 雾（P13f，rea-p13-lights 第 2 节，p13-REPORT「P13f 的实测」F1–F5）：四个引擎 uniform 加两个引擎宏。
 * - **宏**：`FOG_DIST` / `FOG_HEIGHT` 只在材质加载时定（`FUN_1401a5c40`），条件是 general 的开关为真且组合表（并进着色器注解缺省值之后）
 *   里 `FOG` 非 0；后一半由翻译器按最终组合表裁决（请求的 `fogDefines`）。运行中改开关不重编，画面逐像素不变（F3）。
 * - **uniform**：`general.fog*` 的任一字段改动，WPE 整组重算（`FUN_140186440`）；这里每次按 `SceneState.general` 现算，属性、关键帧、
 *   脚本写入都就地生效（F4）。颜色原值；参数 `(start, end − start, startdensity, enddensity − startdensity)`，差值按 float32 减法。
 */
import type { GeneralValues } from "./bindings";

/** 两个开关在加载时的值 → 翻译请求的 `fogDefines`。都关时为空（请求里不写这个键）。 */
export function fogDefines(general: Pick<GeneralValues, "fogdistance" | "fogheight">): Record<string, string> {
  const defines: Record<string, string> = {};
  if (general.fogdistance) defines.FOG_DIST = "1";
  if (general.fogheight) defines.FOG_HEIGHT = "1";
  return defines;
}

/** 四个雾 uniform 的名字（引擎 uniform 表与就地刷新共用）。 */
export const FOG_UNIFORMS = [
  "g_FogDistanceColor",
  "g_FogDistanceParams",
  "g_FogHeightColor",
  "g_FogHeightParams",
] as const;

/** general 的雾字段是不是会进 uniform 的那几个（开关以外的 12 个）：写了要刷新声明了雾 uniform 的绘制。 */
export function isFogUniformField(key: string): boolean {
  return key.startsWith("fog") && key !== "fogdistance" && key !== "fogheight";
}

type FogFields = Pick<
  GeneralValues,
  | "fogdistancecolor"
  | "fogheightcolor"
  | "fogdistancestart"
  | "fogdistanceend"
  | "fogdistancestartdensity"
  | "fogdistanceenddensity"
  | "fogheightstart"
  | "fogheightend"
  | "fogheightstartdensity"
  | "fogheightenddensity"
>;

/** 当前字段 → 四个 uniform（`FUN_140186440`）。 */
export function fogUniforms(general: FogFields): Record<(typeof FOG_UNIFORMS)[number], number[]> {
  const f = Math.fround;
  const params = (start: number, end: number, startDensity: number, endDensity: number) => [
    f(start),
    f(f(end) - f(start)),
    f(startDensity),
    f(f(endDensity) - f(startDensity)),
  ];
  return {
    g_FogDistanceColor: [...general.fogdistancecolor],
    g_FogDistanceParams: params(
      general.fogdistancestart,
      general.fogdistanceend,
      general.fogdistancestartdensity,
      general.fogdistanceenddensity,
    ),
    g_FogHeightColor: [...general.fogheightcolor],
    g_FogHeightParams: params(
      general.fogheightstart,
      general.fogheightend,
      general.fogheightstartdensity,
      general.fogheightenddensity,
    ),
  };
}
