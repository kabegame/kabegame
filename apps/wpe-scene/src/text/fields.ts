/**
 * 文本对象的排版字段与 WPE 的缺省值（P6b 1c 定义，1d 从 `layout.ts` 拆出）：编译 Worker 只要这两样（`compile/texts.ts` 把
 * scene.json 的字段规整成 `TextFields`），不必连带图集、wpefont 的包装一起进 Worker。`layout.ts` 原样再导出。
 */

/** 排版用到的文本对象字段（rea-p6b-layout 1.2），外加决定 `padding` 的两项图层状态。 */
export interface TextFields {
  text: string;
  font: string;
  pointsize: number;
  padding: readonly [number, number];
  spacing: readonly [number, number];
  maxwidth: number;
  maxrows: number;
  limitwidth: boolean;
  limitrows: boolean;
  limituseellipsis: boolean;
  blockalign: boolean;
  opaquebackground: boolean;
  horizontalalign: "left" | "center" | "right";
  verticalalign: "top" | "center" | "bottom";
  /** 可见的 effect 个数（WPE `+0x320`）：大于 0 时文字画进合成 RT、加 `padding`。 */
  visibleEffects: number;
  /** `colorBlendMode`：0、31 以外的值也走合成（WPE `+0x304 & 0x10`）。 */
  colorBlendMode: number;
}

/** WPE 的缺省值（构造 `FUN_140256ae0`）。 */
export const TEXT_DEFAULTS: TextFields = {
  text: "",
  font: "systemfont_arial",
  pointsize: 32,
  padding: [32, 32],
  spacing: [0, 0],
  maxwidth: 500,
  maxrows: 1,
  limitwidth: false,
  limitrows: false,
  limituseellipsis: false,
  blockalign: false,
  opaquebackground: false,
  horizontalalign: "center",
  verticalalign: "center",
  visibleEffects: 0,
  colorBlendMode: 0,
};
