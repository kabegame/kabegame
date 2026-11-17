/**
 * 运行中结构变化的宿主侧共用步骤（P6d3a）：宿主 `beforeFrame` 与 dev 探针跑脚本用同一套接线，所以放在这里。
 * - `settleDestroyed`：脚本阶段之后让待删生效（`SceneState.flushDestroy`），再让脚本运行时对被删对象收 `destroy`、摘条目；
 * - `reparentNeedsRecompile` / `destroyNeedsRecompile`：判断这次结构变化会不会改编译产物（组归属、挂点），要不要请求重编译。宁可多编，不要漏。
 */
import type { SceneBundle } from "../compile/bundle";
import { normalizeConfig } from "../compile/config";
import type { SceneStructure } from "../compile/protocol";
import { layerShellValues } from "../compile/layerShell";
import type { SceneObject } from "../compile/model";
import { layerStateFromShell, type SceneState } from "../render/state";
import { createdLayerKind } from "./createConfig";
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

/** 新建对象配置原文的规整键（同片段缓存的键）；不是合法 JSON 时用原文。 */
function createdKey(config: string): string {
  try {
    const parsed: unknown = JSON.parse(config);
    return parsed && typeof parsed === "object" ? normalizeConfig(parsed) : config;
  } catch {
    return config;
  }
}

/**
 * 宿主维护的结构（`SceneStructure`）：删除生效时追加进 `destroyed`；换父成功时删掉这个对象之前的项再追加 `[对象, 新父, 挂点名]`。
 * 原地改、返回同一个对象（宿主跨重编译持有它）。
 *
 * 去重（L5，P6d4 点 7）：被删的是新建对象、且结构里已有同一规整配置的已删新建对象时，摘掉旧的那条（`created` 与 `destroyed` 各一项）。建了又删的对象
 * 只给整场重载兜底（编译时放进场景再当作不存在），每种配置留一个就够；不去重的话对象池类场景（每帧建删）的结构无限增长，每次重编译都带着。
 */
export function recordDestroyed(structure: SceneStructure, objects: readonly number[]): void {
  for (const object of objects) if (!structure.destroyed.includes(object)) structure.destroyed.push(object);
  // 被删对象的换父记录不再有意义（编译时这一项已是 null）
  const gone = new Set(objects);
  structure.parents = structure.parents.filter(([object]) => !gone.has(object));
  for (const object of objects) {
    const entry = structure.created.find((item) => item.object === object);
    if (!entry) continue;
    const key = createdKey(entry.config);
    const stale = structure.created.filter(
      (item) => item.object !== object && structure.destroyed.includes(item.object) && createdKey(item.config) === key,
    );
    if (stale.length === 0) continue;
    const drop = new Set(stale.map((item) => item.object));
    structure.created = structure.created.filter((item) => !drop.has(item.object));
    structure.destroyed = structure.destroyed.filter((item) => !drop.has(item));
  }
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

/**
 * 新建对象的下标分配器（P6d3b）：宿主 / 探针各持一份，只增不减、跨重编译保留，「清空脚本存储」时清零。`next` 是下一个可用的 `objects` 下标。
 */
export interface ObjectAllocator {
  next: number;
}

/** 编译出新 bundle 后同步分配器：不小于 `bundle.configs.length`（加载时的对象数加上已建的，下标在它之后）。 */
export function syncAllocator(allocator: ObjectAllocator, bundle: SceneBundle | null | undefined): void {
  allocator.next = Math.max(allocator.next, bundle?.configs?.length ?? 0);
}

/**
 * `createLayer` 当场建出待编对象（宿主与 dev 探针共用，P6d3b）：分配下标、按配置的字段值建图层状态并追加到对象表尾（`SceneState.addLayer`）、
 * 记进结构（`structure.created`，之后每次编译带上）。`parent` 是已解析好的父 `objects` 下标（当时存在、没待删的才传）；不在状态里的当根。
 * 配置不是合法 JSON 返回 null（调用方已经整理过，正常不会发生）。数组配置建出空名分组节点（取值全缺省）。
 */
export function createStructureObject(
  state: SceneState,
  structure: SceneStructure,
  allocator: ObjectAllocator,
  configText: string,
  parent: number | null,
): number | null {
  const object = allocator.next;
  if (!addShellObject(state, object, configText, parent)) return null;
  allocator.next++;
  structure.created.push({ object, config: configText });
  return object;
}

/**
 * 在状态上按给定下标建一个待编对象的壳（`createStructureObject` 的状态一半；L5：整场重载进行中建的对象，在新场景上照旧下标再建一次壳）。
 * 不分配下标、不记结构。父不在状态里或待删时当根。配置不是合法 JSON 对象 / 数组时返回 false。
 */
export function addShellObject(state: SceneState, object: number, configText: string, parent: number | null): boolean {
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return false;
  }
  if (config === null || typeof config !== "object") return false;
  const kind = createdLayerKind(config as Record<string, unknown> | unknown[]);
  const shell = layerShellValues((Array.isArray(config) ? {} : config) as SceneObject);
  const root = parent === null || !state.layers.has(parent) || state.pendingDestroy.has(parent) ? null : parent;
  state.addLayer(object, layerStateFromShell(shell, root, { imageLayer: kind === "image" }));
  return true;
}
