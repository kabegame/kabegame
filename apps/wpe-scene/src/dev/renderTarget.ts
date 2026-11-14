/**
 * dev 探针 `renderFrame` 的「按指定尺寸画」（`.claude/plans/wpe-import/3-scene/phase-render-size.md`）：正交场景给了 `canvas` 时，
 * 场景目标就是 `canvas`，壁纸样式照 WPE 做进正交投影的四个裁切边距（`render/layout.ts` 的 `alignEdges`），读回场景目标本身。
 * 这个文件只放参数校验与「这次怎么画」的决定（纯函数），GPU 与回放仍在 `probe.ts`。
 *
 * 画法有三种，结果的 `render.mode` 给出：
 * - `target`：正交场景 + `canvas`，按指定尺寸画（缺省，验收用）；
 * - `scene`：旧的「场景分辨率 + 读回时按 fill 铺进画布」（`renderMode: "scene"` 要的，字节同以前），或没给 `canvas` 时读回场景目标；
 * - `perspective`：透视场景，本来就按画布尺寸画（P5d 步骤 2）。
 */
import { ALIGNMENT_OF_STYLE, alignEdges, clearsWithSchemeColor, type Edges, type SceneStyle } from "../render/layout";

export type RenderMode = "target" | "scene";
/** 探针收的样式：照 WPE 的对齐方式，tile 没有对应、不收。 */
export type ProbeStyle = Exclude<SceneStyle, "tile">;

const STYLES: readonly string[] = ["fill", "fit", "stretch", "center"] satisfies ProbeStyle[];
const MODES: readonly string[] = ["target", "scene"] satisfies RenderMode[];

/** 校验 `style`（缺省 fill）。tile 单独报错（WPE 没有对应的对齐方式），其余未知值也报错。 */
export function checkRenderStyle(style: unknown): ProbeStyle {
  if (style === undefined) return "fill";
  if (style === "tile") throw new Error("style 不收 tile：WPE 的对齐方式只有 fill / fit / stretch / center 四种能对上");
  if (typeof style !== "string" || !STYLES.includes(style))
    throw new Error(`style 要是 ${STYLES.join(" / ")} 之一，收到 ${JSON.stringify(style)}`);
  return style as ProbeStyle;
}

/** 校验 `renderMode`；不给时返回 undefined（由有没有 `canvas` 决定）。 */
export function checkRenderMode(mode: unknown): RenderMode | undefined {
  if (mode === undefined) return undefined;
  if (typeof mode !== "string" || !MODES.includes(mode))
    throw new Error(`renderMode 要是 ${MODES.join(" / ")} 之一，收到 ${JSON.stringify(mode)}`);
  return mode as RenderMode;
}

/**
 * 这次要不要按指定尺寸画：正交场景、给了 `canvas`、没要 `renderMode: "scene"`。显式要 `target` 却没给 `canvas` 抛错
 * （没有尺寸可指定）；透视场景不走这条（本来就按画布尺寸画），显式要 `target` 也不报错，结果里记成 `perspective`。
 */
export function wantsSizedTarget(input: {
  renderMode?: RenderMode;
  hasCanvas: boolean;
  perspective: boolean;
}): boolean {
  if (input.renderMode === "target" && !input.hasCanvas)
    throw new Error("renderMode: target 要同时给 canvas（按它的尺寸画）");
  return !input.perspective && input.hasCanvas && input.renderMode !== "scene";
}

/** 这次的画法，写进结果的 `render`。 */
export interface RenderDescription {
  mode: RenderMode | "perspective";
  /** 按指定尺寸画时用的样式；其余画法为 null。 */
  style: ProbeStyle | null;
  /** WPE 的对齐方式（`ALIGNMENT_OF_STYLE`）；其余画法为 null。 */
  alignment: number | null;
  /** 投影的裁切边距 `[E0 左, E1 上, E2 右, E3 下]`（场景单位）；其余画法为 null。 */
  edges: Edges | null;
  /** 场景目标的清屏色（对齐方式 1 / 3 的 `schemecolor`）；用 `clearcolor` 时为 null。 */
  clear: [number, number, number] | null;
}

/** 按指定尺寸画的计划：交给 `GpuScene.build` 的 `target`，加上写进结果的说明。 */
export interface SizedTargetPlan {
  target: { size: [number, number]; edges: Edges; clear: [number, number, number] | null };
  render: RenderDescription;
}

/** 这个样式清屏时要不要 `schemecolor`（探针据此决定读不读属性全集）。 */
export function styleNeedsSchemeColor(style: ProbeStyle): boolean {
  return clearsWithSchemeColor(ALIGNMENT_OF_STYLE[style]!);
}

/**
 * 按指定尺寸画的计划。`scene` 是场景分辨率、`canvas` 是窗口（= 场景目标）尺寸；`scheme` 是 `schemecolor`（属性全集里的值，
 * `sceneStyle.ts` 的 `schemeColor`），样式不需要它时可以不给。
 */
export function planSizedTarget(
  scene: readonly [number, number],
  canvas: readonly [number, number],
  style: ProbeStyle,
  scheme?: readonly [number, number, number],
): SizedTargetPlan {
  const alignment = ALIGNMENT_OF_STYLE[style]!;
  const edges = alignEdges(alignment, scene[0], scene[1], canvas[0], canvas[1]);
  const needs = clearsWithSchemeColor(alignment);
  if (needs && !scheme) throw new Error(`样式 ${style} 清屏用 schemecolor，要给它的值`);
  const clear: [number, number, number] | null = needs ? [scheme![0], scheme![1], scheme![2]] : null;
  return {
    target: { size: [canvas[0], canvas[1]], edges, clear },
    render: { mode: "target", style, alignment, edges, clear },
  };
}

/** 不是按指定尺寸画时的说明（`scene` 或 `perspective`）。 */
export function otherRender(mode: "scene" | "perspective"): RenderDescription {
  return { mode, style: null, alignment: null, edges: null, clear: null };
}

/**
 * 不按指定尺寸画时 `style` 没有作用：给了不是缺省 fill 的值就报错，免得以为生效了（`scene` 模式读回时固定按 fill 铺放，透视场景不读对齐方式）。
 */
export function checkStyleUnused(
  style: ProbeStyle | undefined,
  rawGiven: boolean,
  mode: "scene" | "perspective",
): void {
  if (rawGiven && style !== "fill")
    throw new Error(
      `style ${style} 只在按指定尺寸画时有效（当前是 ${mode}：${mode === "scene" ? "读回固定按 fill 铺放" : "透视场景按画布尺寸、不读对齐方式"}）`,
    );
}
