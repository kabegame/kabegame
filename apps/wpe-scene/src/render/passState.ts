/**
 * 脚本写过的材质状态字段落到规划上（P6d1b，`rea-p6d1-matstate.md` 第 6、7 节）：规划图层前把「bundle 值 + 覆盖」拼成有效的 pass，
 * 现有的角色规则（`graph.ts` 的 `rasterState`：上屏 pass 的混合与深度借基础材质、剔除用自己、中间 pass 的 normal 是不混合、
 * translucent / additive 关深度写；`writeState.ts` 的写掩码与 A2C）一条不改，照有效的 pass 算。程序（着色器）不换。
 */
import type { SceneEffect, SceneLayer, ScenePass } from "../compile/bundle";
import type { TargetKey } from "../compile/bindings";
import { PASS_STATE_FIELDS, type PassStateField } from "../compile/passState";

export type PassStateOverride = Partial<Record<PassStateField, string>>;

/**
 * 一个 pass 的有效版本：把覆盖盖到 `ScenePass` 上。`alphawriting` 只有 `enabled` / `disabled` 才写 `ScenePass.alphaWriting`，`default`
 * 与编译期一样不写这个键（和「把同样的值写进材质整场编译」得到的 `ScenePass` 逐字段相同）。没有覆盖返回原对象。
 */
export function withPassState(pass: ScenePass, override: PassStateOverride | undefined): ScenePass {
  if (!override || !PASS_STATE_FIELDS.some((field) => override[field] !== undefined)) return pass;
  const next: ScenePass = { ...pass };
  if (override.blending !== undefined) next.blending = override.blending;
  if (override.cullmode !== undefined) next.cullmode = override.cullmode;
  if (override.depthtest !== undefined) next.depthtest = override.depthtest;
  if (override.depthwrite !== undefined) next.depthwrite = override.depthwrite;
  if (override.alphawriting !== undefined) {
    if (override.alphawriting === "default") delete next.alphaWriting;
    else next.alphaWriting = override.alphawriting as "enabled" | "disabled";
  }
  return next;
}

/**
 * 图层的有效版本：基础材质 pass 与 effect 的绘制 pass 取有效值，别的原样。没有一个 pass 被写过时返回原对象（规划结果、签名与改前逐字节相同）。
 * 脚本写得到的只有这两种 pass（`script/api.ts` 的 `findPass`）。
 */
export function applyPassStates(layer: SceneLayer, states: ReadonlyMap<TargetKey, PassStateOverride>): SceneLayer {
  if (!states.size) return layer;
  let changed = false;
  const passes = layer.passes.map((pass) => {
    const next = withPassState(pass, states.get(pass.key));
    if (next !== pass) changed = true;
    return next;
  });
  const effects = layer.effects.map((effect): SceneEffect => {
    let effectChanged = false;
    const steps = effect.steps.map((step) => {
      if (step.kind !== "draw") return step;
      const pass = withPassState(step.pass, states.get(step.pass.key));
      if (pass === step.pass) return step;
      effectChanged = true;
      return { ...step, pass };
    });
    if (!effectChanged) return effect;
    changed = true;
    return { ...effect, steps };
  });
  return changed ? { ...layer, passes, effects } : layer;
}
