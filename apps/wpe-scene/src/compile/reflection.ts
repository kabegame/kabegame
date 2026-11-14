/**
 * 平面反射 pass 的名单（P13b2，`.claude/plans/wpe-import/3-scene/phase13/phase-13b2-reflection-on.md`）。
 *
 * WPE（rea-p13-passes 1.4，p13-REPORT C1）：名单在对象创建时建，是可画对象里 `reflected` 不为 false、且不是「读 `_rt_Reflection` 的模型」
 * 的那些，按创建（`objects`）顺序；读反射图的模型只要有一个网格读，整个对象都不进名单。反射 pass 只画名单，不做透明排序。
 *
 * 我们支持四类对象进反射 pass（已定 1，2026-11-14 用户）：模型、直接上屏的图像层与文本层、普通粒子。别的种类在反射开着时照报
 * `reflection:planar:<种类>`（它们的上屏要先跑合成链或快照，在反射 pass 里重跑会改状态，WPE 的行为没测，语料 0 处）。
 */
import type { SceneLayer } from "./bundle";
import type { SceneParticle } from "./particles";

/** 粒子系统树里有一个系统满足 `test`（同 `features.ts` 的 `someParticleSystem`，这里不依赖它）。 */
function someSystem(system: SceneParticle, test: (system: SceneParticle) => boolean): boolean {
  return test(system) || (system.children ?? []).some((child) => someSystem(child.system, test));
}

/**
 * 反射 pass 能不能画这个图层：可画返回 null，否则返回 `reflection:planar:<种类>` 的种类。
 * - `group`：组本身（有子孙）或组里的图层（画进组的合成 RT，不直接上屏）；
 * - `shape`：形状图层；
 * - `perspective`：`perspective: true` 的图像层 / 模型（透视覆盖在反射 pass 里用什么矩阵没测）；
 * - `effect`：带 effect 的图像层 / 文本层（上屏前要跑 effect 链）；
 * - `composite`：不带 effect 但走合成路径的图层（colorBlendMode 混合、被依赖、组合层），上屏要读快照或合成 RT；
 * - `particle-perspective`：粒子树里有透视系统（`flags & 4`）；
 * - `particle-framebuffer`：粒子树里有要快照的材质（折射等）；
 * - `sprite`：sprite 对象（P13c）。
 * 模型、直接上屏的图像层（含 puppet）与文本层、其余粒子可画。
 */
export function reflectionKind(
  layer: Pick<
    SceneLayer,
    | "group"
    | "subtree"
    | "shape"
    | "perspective"
    | "effects"
    | "colorBlendMode"
    | "dependedOn"
    | "passthroughModel"
    | "particle"
    | "model"
    | "sprite"
    | "text"
  >,
): string | null {
  if (layer.group !== null || layer.subtree.length > 0) return "group";
  // sprite（P13c）：WPE 在反射 pass 里也画它，「谁先画谁做遮挡测试」，矩阵怎么镜像没查清（rea-p13-lights「未查清」），语料 0 处
  if (layer.sprite) return "sprite";
  if (layer.shape) return "shape";
  if (layer.perspective) return "perspective";
  if (layer.particle) {
    if (someSystem(layer.particle, (system) => (system.flags & 4) !== 0)) return "particle-perspective";
    if (someSystem(layer.particle, (system) => system.passes.some((pass) => pass.framebuffer)))
      return "particle-framebuffer";
    return null;
  }
  if (layer.model) return null;
  if (layer.effects.length > 0) return "effect";
  const cbm = layer.colorBlendMode;
  if ((cbm !== 0 && cbm !== 31) || layer.dependedOn || layer.passthroughModel) return "composite";
  return null;
}

/**
 * 反射名单（`objects` 下标，按图层顺序 = `objects` 顺序）：`reflected(object)` 为 false 的、`excluded`（读反射图的模型）里的不进。
 * `reflected` 由调用方解析（绑用户属性时登记重编译，已定 2）。
 */
export function reflectionList(
  layers: readonly Pick<SceneLayer, "object">[],
  excluded: ReadonlySet<number>,
  reflected: (object: number) => boolean,
): number[] {
  return layers
    .map((layer) => layer.object)
    .filter((object) => !excluded.has(object) && reflected(object))
    .sort((a, b) => a - b);
}
