/**
 * 脚本写回与读取里只依赖 `SceneState` 的部分（kabegame-chromium 第 7 批）：宿主（`host.ts` 的 `writeScript` / `readScript` /
 * `overrideAndReload`）与 dev 探针跑脚本（`dev/probeScripts.ts`）共用这一份，不各写一份。宿主另外做的事留在宿主：声音的 `volume` 当场
 * 交给排期器、重编译类写入记进覆盖表后整场重编译（探针做不了，只记下来）。
 */
import type { SceneBundle } from "../compile/bundle";
import { FLT_MAX, instanceControlPoint, type InstanceField } from "../compile/particles";
import { scriptWriteValue, type SceneState } from "../render/state";
import { textFieldFromScript } from "../text/fields";
import type { ScriptTarget, ScriptValue } from "./runtime";

/**
 * 一次脚本写回的结果：`applied` 写进了状态；`recompile` 要整场重编译才生效（重编译类目标，以及 `SceneState.write` 判定要重编译的开关：
 * 打开带不支持项的 effect、切换冻结的图层、打开没有泛光链的场景），状态不变（bloom 位例外，见 `SceneState.write`）；`unsupported` 是写不进
 * 状态的目标（`unsupported`、`script-property`），什么都没做。
 */
export type ScriptStateWrite = "applied" | "recompile" | "unsupported";

/**
 * 把脚本写回的值写进状态。文本字段（P6b 1e）按脚本侧规则规整（`ToString`、枚举查表、布尔位只收布尔），值变了才标脏重排、不走重编译；
 * 其余目标经 `SceneState.write`，值先按 `scriptWriteValue` 换算（多分量拼成空格分隔、单分量传数字）。
 */
export function writeScriptState(
  state: Pick<SceneState, "write" | "writeText">,
  target: ScriptTarget,
  value: ScriptValue,
): ScriptStateWrite {
  if (target.kind === "unsupported" || target.kind === "script-property") return "unsupported";
  if (target.kind === "recompile") return "recompile";
  if (target.kind === "text") {
    state.writeText(target.object, target.field, textFieldFromScript(target.field, scriptWriteValue(value)));
    return "applied";
  }
  return state.write({ property: "", target }, scriptWriteValue(value));
}

/** 脚本读到的目标当前值（字段脚本 `update(value)` 收到的、API 读到的）；状态里没有这一项时为 null。 */
export function readScriptState(state: SceneState, target: ScriptTarget): ScriptValue | null {
  if (target.kind === "layer") {
    const value = state.layers.get(target.object)?.[target.field];
    return value === undefined ? null : typeof value === "number" ? [value] : value;
  }
  if (target.kind === "effect") return state.effectEnabled(target.object, target.effect);
  if (target.kind === "constant") return state.constants.get(target.pass)?.[target.uniforms[0]] ?? null;
  if (target.kind === "bloom") {
    const value = state.bloom[target.field];
    return Array.isArray(value) ? value : [value];
  }
  if (target.kind === "bloom-enabled") return state.bloomEnabled;
  if (target.kind === "general") {
    const value = state.general[target.key];
    return typeof value === "number" ? [value] : value;
  }
  if (target.kind === "sound") {
    const value = state.sounds.get(target.object)?.volume;
    return value === undefined ? null : [value];
  }
  // 相机对象的 `fov` / `zoom`（P5d 步骤 3）：`update(value)` 收到当前值
  if (target.kind === "camera") {
    const value = state.cameras.get(target.object)?.[target.field];
    return value === undefined ? null : [value];
  }
  // 文本字段（P6b 1e）：当前排版字段，`update(value)` 收到的是现在的文字（计数器不到刷新间隔时原样返回它）
  if (target.kind === "text") {
    const value = state.textFields.get(target.object)?.[target.field];
    if (value === undefined) return null;
    return typeof value === "number" ? [value] : typeof value === "object" ? [...value] : value;
  }
  // 粒子 `instanceoverride` 的字段脚本（P4f 步骤 1）：`update` 收到实例覆盖里的当前值（WPE 的 `io`，rea-p4f-script.md 5.1），重算或
  // 加载钳过的 `rate` 是钳过的值、单写的 `rate` 是原值；`colorn` 没设过时是 (−1, −1, −1)，控制点（P4f 步骤 3）没设过时是 (FLT_MAX, 0, 0)
  if (target.kind === "particle-instance") {
    const values = state.particleInstances.get(target.object);
    if (!values) return null;
    if (target.field === "colorn") return values.colorn ? [...values.colorn] : [-1, -1, -1];
    const point = instanceControlPoint(target.field);
    if (point) {
      const value = (point.angle ? values.controlpointAngles : values.controlpoints)[point.index];
      return value ? [...value] : [FLT_MAX, 0, 0];
    }
    return [values[target.field as InstanceField]];
  }
  return null;
}

/** 重编译类目标在编译期的值：脚本第一次写就写成它时不算变化。目前只有 `general/hdr`（场景位）读得到，其余为 undefined。 */
export function compiledRecompileValue(
  general: Pick<SceneBundle["general"], "postprocess"> | undefined,
  path: string,
): number[] | boolean | undefined {
  return path === "general/hdr" ? general?.postprocess.hdrFlag : undefined;
}

/**
 * 脚本写重编译类目标（`path` 是目标路径，同 `targetKey`）：值真的变了才记进 `overrides` 并返回 true（宿主据此整场重编译，探针据此记一条
 * 「做不了」）。同上一次写的值、或第一次写就等于编译期的值（`compiledRecompileValue`）时返回 false、不记：脚本可能每帧写同一个值。
 */
export function recordRecompileWrite(
  overrides: Map<string, ScriptValue>,
  general: Pick<SceneBundle["general"], "postprocess"> | undefined,
  path: string,
  value: ScriptValue,
): boolean {
  const old = overrides.get(path);
  if (JSON.stringify(old) === JSON.stringify(value)) return false;
  if (old === undefined && JSON.stringify(compiledRecompileValue(general, path)) === JSON.stringify(value))
    return false;
  overrides.set(path, value);
  return true;
}
