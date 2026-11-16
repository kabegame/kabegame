/**
 * 灯的运行时（P13f2，`.claude/plans/wpe-import/3-scene/phase13/phase-13f-fog-lights.md`，rea-p13-lights 第 3 节，p13-REPORT「P13f 的实测」L1–L4）：
 * 每帧按 `SceneState` 现组灯记录，WPE 的灯字段都没有改值回调、逐帧读。
 * - 世界矩阵与可见性沿父链（同图层，`worldMatrixOf` / `effectiveVisible`；父是带骨骼的模型时取模型的 `W`，不含骨骼，挂点照图层规则）；
 * - V1 灯（`lpoint` 等）用本帧（动画、脚本之后）的状态，排序键取局部 origin（L2′）；
 * - 遗留灯（`point`）WPE 在动画与脚本之前写，渲染器用上一帧末的状态（L1：晚一帧），见 `GpuScene` 的 `legacyValues`。
 * 被删的对象（P6d3）不在 `state.layers` 里，跳过。
 */
import type { SceneLightObject, SceneLight, LegacyLightInput } from "../compile/lights";
import { sceneLightOf } from "../compile/lights";
import type { SceneState } from "./state";
import { effectiveVisible, worldMatrixOf } from "./layout";
import type { Mat4 } from "./math";

type AttachHook = (object: number) => Mat4 | null;

/** 这一帧的 V1 灯记录（`objects` 顺序，不排序）。 */
export function lightRecords(
  lights: readonly SceneLightObject[],
  state: SceneState,
  worlds: Map<number, Mat4>,
  attach?: AttachHook,
): SceneLight[] {
  const out: SceneLight[] = [];
  for (const light of lights) {
    if (!light.kind) continue;
    const layer = state.layers.get(light.object);
    const values = state.lights.get(light.object);
    if (!layer || !values) continue;
    const record = sceneLightOf(light, values, {
      visible: effectiveVisible(light.object, state.layers),
      world: worldMatrixOf(light.object, state.layers, worlds, attach),
      localOrigin: layer.origin,
      color: layer.color,
    });
    if (record) out.push(record);
  }
  return out;
}

/** 这一帧的遗留灯输入（全部灯对象，按 `objects` 顺序；不是遗留灯的只占槽）。 */
export function legacyLightInputs(
  lights: readonly SceneLightObject[],
  state: SceneState,
  worlds: Map<number, Mat4>,
  attach?: AttachHook,
): LegacyLightInput[] {
  const out: LegacyLightInput[] = [];
  for (const light of lights) {
    const layer = state.layers.get(light.object);
    const values = state.lights.get(light.object);
    if (!layer || !values) continue;
    const world = light.legacy ? worldMatrixOf(light.object, state.layers, worlds, attach) : null;
    out.push({
      slot: light.legacySlot,
      legacy: light.legacy,
      visible: effectiveVisible(light.object, state.layers),
      position: world ? [world[12], world[13], world[14]] : [0, 0, 0],
      color: layer.color,
      intensity: values.intensity,
      radius: values.radius,
    });
  }
  return out;
}
