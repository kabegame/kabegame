/**
 * 运行中结构变化的宿主侧共用步骤（P6d3a）：宿主 `beforeFrame` 与 dev 探针跑脚本用同一套接线，所以放在这里。
 * - `settleDestroyed`：脚本阶段之后让待删生效（`SceneState.flushDestroy`），再让脚本运行时对被删对象收 `destroy`、摘条目；
 * - `reparentNeedsRecompile` / `destroyNeedsRecompile`：判断这次结构变化会不会改编译产物（组归属、挂点），要不要请求重编译。宁可多编，不要漏。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneStructure } from "../compile/protocol";
import type { SceneState } from "../render/state";
import type { ScriptRuntime } from "./runtime";

export interface SettleHooks {
  /** 脚本运行时（没有脚本的场景为 null / 不传）。 */
  runtime?: Pick<ScriptRuntime, "destroyObjects"> | null;
  /** 当前场景的 bundle：判断删除会不会改组归属（不传当不会）。 */
  bundle?: SceneBundle | null;
  /**
   * 删除已生效、脚本已收 `destroy`：宿主在这里记结构、清理声音 / 光标等宿主侧子系统；`regroup` 为真时删除改了组归属，要重编译。
   */
  removed?(objects: number[], regroup: boolean): void;
}

/** 组（模型 JSON `passthrough: true` 的图像层，不看有没有子层）。 */
function isGroup(bundle: SceneBundle | null | undefined, object: number): boolean {
  return bundle?.layers.find((layer) => layer.object === object)?.passthroughModel === true;
}

/** 自身与父链上有没有组。 */
function chainHasGroup(state: SceneState, bundle: SceneBundle | null | undefined, object: number | null): boolean {
  const seen = new Set<number>();
  for (
    let current = object;
    current !== null && !seen.has(current);
    current = state.layers.get(current)?.parent ?? null
  ) {
    seen.add(current);
    if (isGroup(bundle, current)) return true;
  }
  return false;
}

/** 这个对象的子树（自身与子孙）里有没有组。 */
function subtreeHasGroup(state: SceneState, bundle: SceneBundle | null | undefined, object: number): boolean {
  return state.subtree(object).some((item) => isGroup(bundle, item));
}

/**
 * 换父会不会改编译产物：挂点在换父前后有一边不为空；自己的子树里有组；旧父链或新父链上有组（含新父、旧父本身）。
 * 在 `state.setParent` 之后调也成立：只看子树与两条父链，它们不含自己。
 */
export function reparentNeedsRecompile(input: {
  state: SceneState;
  bundle: SceneBundle | null | undefined;
  object: number;
  oldParent: number | null;
  parent: number | null;
  oldBone: string | null;
  bone: string | null;
}): boolean {
  const { state, bundle, object, oldParent, parent, oldBone, bone } = input;
  if (oldBone !== null || bone !== null) return true;
  return (
    subtreeHasGroup(state, bundle, object) ||
    chainHasGroup(state, bundle, oldParent) ||
    chainHasGroup(state, bundle, parent)
  );
}

/** 删除会不会改组归属：被删对象是组，或它自己在组里（由组代画）、有在组里的祖先 / 子孙。 */
export function destroyNeedsRecompile(
  state: SceneState,
  bundle: SceneBundle | null | undefined,
  objects: Iterable<number>,
): boolean {
  if (!bundle) return false;
  for (const object of objects) {
    const layer = bundle.layers.find((item) => item.object === object);
    if (layer && layer.group != null) return true;
    if (chainHasGroup(state, bundle, object) || subtreeHasGroup(state, bundle, object)) return true;
  }
  return false;
}

/**
 * 删除生效（rea-p6d-layers 4.2 第 7.5 步）：全部脚本（含计时器、`update`）之后、绘制之前调一次。先判断会不会改组归属（要在摘表之前，
 * 摘表会改父子关系），再 `flushDestroy`，非空时让脚本对被删对象收 `destroy` 并摘条目，最后交给宿主的 `removed`。返回生效的对象。
 */
export function settleDestroyed(state: SceneState, hooks: SettleHooks = {}): number[] {
  const regroup = destroyNeedsRecompile(state, hooks.bundle, state.pendingDestroy);
  const removed = state.flushDestroy();
  if (removed.length === 0) return removed;
  hooks.runtime?.destroyObjects(new Set(removed));
  hooks.removed?.(removed, regroup);
  return removed;
}

/**
 * 宿主维护的结构（`SceneStructure`）：删除生效时追加进 `destroyed`；换父成功时删掉这个对象之前的项再追加 `[对象, 新父, 挂点名]`。
 * 原地改、返回同一个对象（宿主跨重编译持有它）。
 */
export function recordDestroyed(structure: SceneStructure, objects: readonly number[]): void {
  for (const object of objects) if (!structure.destroyed.includes(object)) structure.destroyed.push(object);
  // 被删对象的换父记录不再有意义（编译时这一项已是 null）
  const gone = new Set(objects);
  structure.parents = structure.parents.filter(([object]) => !gone.has(object));
}

export function recordReparent(
  structure: SceneStructure,
  object: number,
  parent: number | null,
  bone: string | null,
): void {
  structure.parents = structure.parents.filter(([item]) => item !== object);
  structure.parents.push([object, parent, bone]);
}
