import { planApply, type SceneBinding, type UserProperty } from "../compile/bindings";
import { type SceneScalar } from "../compile/model";
import { type SceneScripts } from "../compile/scripts";
import { type SceneState } from "../render/state";
import { targetKey } from "./runtime";

/**
 * 加载时「挂脚本又绑属性」的字段套属性值（修复：P3a / P3b 加载顺序的缺口）。
 *
 * WPE 的首次加载顺序是「解析期写 JSON `value` → `init` 写回 → 以属性全集为增量走一次直接绑定 → 首帧」：`init` 拿到 JSON 的 `value`，
 * 首帧之前被属性值盖掉（同时带 `user` 与 `script` 的字段，p3-script-REPORT I1 / K3）。我们的编译期对不挂脚本的字段直接取属性值，
 * 挂脚本的字段取 JSON `value`（给 `init`），缺的就是 `init` 之后这一次全集绑定。这里补上：按属性全集算绑定计划，
 * 只取目标落在「有脚本的目标」上的就地写。
 *
 * `first` 为真（`init` 刚跑过）：这些目标全部覆盖，并忘掉脚本记下的旧写入（`init` 的写回被属性盖掉，重编译重放不该再放回去）。
 * 为假（重编译）：只补脚本没有写入记录的目标——有记录的是脚本最近一次写回，重放才是对的；没有记录的目标编译期取的是 JSON `value`，
 * 要换回属性值，否则只有 `init` 的脚本重编译后会回到 JSON `value`。
 *
 * `needsRecompile` 挡下的条目（打开带不支持项的 effect 之类）与重编译类目标一律忽略：编译期已按当前属性编过，这里不再触发重编译。
 * 返回实际写了的目标路径数，给测试与日志。
 */
export function applyScriptedProperties(
  bindings: readonly SceneBinding[],
  scripts: SceneScripts,
  properties: ReadonlyMap<string, UserProperty>,
  state: SceneState,
  runtime: { hasWrite(key: string): boolean; forgetWrite(key: string): void } | null,
  first: boolean,
): number {
  if (!scripts.list.length) return 0;
  const scripted = new Set(scripts.list.map((script) => targetKey(script.target)));
  const changes = new Map<string, SceneScalar>();
  for (const [key, property] of properties) changes.set(key, property.value as SceneScalar);
  let count = 0;
  for (const { binding, value } of planApply(bindings, changes).writes) {
    const key = targetKey(binding.target);
    if (!scripted.has(key)) continue;
    if (!first && runtime?.hasWrite(key)) continue;
    if (state.needsRecompile(binding, value)) continue;
    state.write(binding, value);
    if (first) runtime?.forgetWrite(key);
    count++;
  }
  return count;
}
