/**
 * WPE 注入的 14 个内置属性（P3a 修复，2026-11-14）：`project.json` 不声明，但 WPE 首次加载就把它们放进属性全集，所以绑定、脚本的
 * `engine.userProperties`（`init` 里就有）与首次 `applyUserProperties` 都看得到（p3-script-REPORT I4 / I5）。`ignore/p3a-missing/` 的
 * `p3am-builtin` 再测过三件事：条件绑定按内置值比较（`rate` 条件 `"100"` 画、`"0"` 不画）；`scriptproperties` 绑内置名取内置值；
 * 工程声明了同名属性（`wec_hue`）时以工程的为准。值与 JS 类型取首次 apply 的实测（`ignore/p3-userprops/dyn-test/log-run-full.txt`、
 * `ignore/p3a-missing/out/wpe-p3amb-log.txt`）。属性不存在时绑定保持 `value`（`model.ts` 的 `resolveValue`），这些名字不能算不存在。
 *
 * 我们不实现对齐与颜色校正，这些值只是数据。运行中改值后 WPE 会把增量没带的内置项从 `engine.userProperties` 里丢掉，这个缺陷不照搬
 * （phase-3b 已定 8）：宿主全集里它们一直在。
 */
import type { SceneStyle } from "../render/layout";
import type { SceneScalar } from "./model";

/** 一个内置项：形状同用户属性（`bindings.ts` 的 `UserProperty`）。 */
export interface BuiltinProperty {
  readonly type: string;
  readonly value: SceneScalar;
}

// TODO:[WPE_SCENE] 没实测：WPE 给内置项的 `type` 字符串。脚本看不到它，只影响 `convertUserProperties` 的分支（`color` / `usershortcut`
// 以外都直接取 `value`），这里按值的类型取 combo / bool / slider
/** 键 → WPE 默认值（首次 apply 实测：数字、布尔、字符串三种 JS 类型）。 */
export const WPE_BUILTIN_PROPERTIES: Readonly<Record<string, BuiltinProperty>> = Object.freeze({
  alignment: { type: "combo", value: 0 },
  alignmentfliph: { type: "bool", value: false },
  alignmentposition: { type: "slider", value: 50 },
  alignmentx: { type: "slider", value: 50 },
  alignmenty: { type: "slider", value: 50 },
  alignmentz: { type: "slider", value: 100 },
  rate: { type: "slider", value: 100 },
  wcc_amt: { type: "slider", value: 100 },
  wcc_v: { type: "combo", value: "" },
  wec_brs: { type: "slider", value: 50 },
  wec_con: { type: "slider", value: 50 },
  wec_e: { type: "bool", value: false },
  wec_hue: { type: "slider", value: 50 },
  wec_sa: { type: "slider", value: 50 },
});

/**
 * Kabegame 壁纸样式 → WPE 的 `alignment`。照用视频壁纸已有的对应，不另定：`apps/kabegame/src/components/wallpaper/WallpaperStage.vue` 的
 * `effectiveAlignment`（fill → cover、fit → fill、stretch → stretch、center → center、tile → cover）与
 * `src-tauri/kabegame-core/src/wpe/properties.rs` 的 `WpeAlignment::from_value`（0 cover、1 fill、2 stretch、3 center、4 free）。
 * 其余对齐项（`alignmentposition` / `x` / `y` / `z` / `fliph`）Kabegame 没有对应的设置，取 WPE 默认值；`rate` 与 `wec_*` / `wcc_*` 同样。
 */
export function wpeAlignmentOf(style: SceneStyle): number {
  switch (style) {
    case "fit":
      return 1;
    case "stretch":
      return 2;
    case "center":
      return 3;
    default:
      return 0;
  }
}

/** 内置项的一份取值（每次新对象）：`alignment` 按壁纸样式（缺省 fill，即 WPE 默认的 0），其余是 WPE 默认值。 */
export function builtinProperties(style: SceneStyle = "fill"): Record<string, { type: string; value: SceneScalar }> {
  const out: Record<string, { type: string; value: SceneScalar }> = {};
  for (const [key, { type, value }] of Object.entries(WPE_BUILTIN_PROPERTIES)) out[key] = { type, value };
  out.alignment = { type: WPE_BUILTIN_PROPERTIES.alignment.type, value: wpeAlignmentOf(style) };
  return out;
}
