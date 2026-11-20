/**
 * 运行中结构变化的宿主侧共用步骤（P6d3a）：宿主 `beforeFrame` 与 dev 探针跑脚本用同一套接线，所以放在这里。
 * - `settleDestroyed`：脚本阶段之后让待删生效（`SceneState.flushDestroy`），再让脚本运行时对被删对象收 `destroy`、摘条目；
 * - `trackGroupIssues`（L7）：换父 / 删除之后登记表 `restructure` 报出的组内不支持组合，加上新组自身的三个场景级条件，和上一次比出新出现与消失的。
 *   结构变化不再整场重编译（L7 删掉了 `reparentNeedsRecompile` / `destroyNeedsRecompile`）：登记表当场重算派生量，渲染器当帧重排。
 */
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { normalizeConfig } from "../compile/config";
import type { SceneStructure } from "../compile/protocol";
import { layerShellValues } from "../compile/layerShell";
import type { SceneObject } from "../compile/model";
import type { RestructureResult } from "../compile/registry";
import { layerStateFromShell, type SceneState } from "../render/state";
import { createdLayerKind } from "./createConfig";
import type { ScriptRuntime } from "./runtime";

export interface SettleHooks {
  /** 脚本运行时（没有脚本的场景为 null / 不传）。 */
  runtime?: Pick<ScriptRuntime, "destroyObjects"> | null;
  /**
   * 删除已生效、脚本已收 `destroy`：宿主在这里记结构、清理声音 / 光标等宿主侧子系统，登记表摘对象并重算组与挂点（L7：一律当场重算，渲染器当帧重排，
   * 不再判断要不要整场重编译）。
   */
  removed?(objects: number[]): void;
}

/**
 * 删除生效（rea-p6d-layers 4.2 第 7.5 步）：全部脚本（含计时器、`update`）之后、绘制之前调一次。`flushDestroy`，非空时让脚本对被删对象收 `destroy`
 * 并摘条目，最后交给宿主的 `removed`。返回生效的对象。
 */
export function settleDestroyed(state: SceneState, hooks: SettleHooks = {}): number[] {
  const removed = state.flushDestroy();
  if (removed.length === 0) return removed;
  hooks.runtime?.destroyObjects(new Set(removed));
  hooks.removed?.(removed);
  return removed;
}

/**
 * 组自身的不支持项（L7）：组合层运行中挂上子层成了组（`passthroughModel` 且 `subtree` 非空），而编译期按「有子层」才报的条件成立：
 * 开雾（`fog:group`；没有子层的组合层开雾时编译期置了 `fogPassthrough`）。键和编译期报的相同（`compile/bundle.ts` 的 `compileOne`）。
 * 不是组时为空。透视场景里的组 P13h 起照画（`camera:perspective:group` 不再报），被依赖的组 P8 步骤 7 起照画（`dependency:group` 不再报）。
 */
export function groupSelfIssues(layer: Pick<SceneLayer, "passthroughModel" | "subtree" | "fogPassthrough">): string[] {
  if (!layer.passthroughModel || !layer.subtree?.length) return [];
  return layer.fogPassthrough ? ["fog:group"] : [];
}

/** `trackGroupIssues` 的结果：这次新出现（或键变了）的对象 → 键，与不再有问题的对象。 */
export interface GroupIssueChanges {
  added: Map<number, string[]>;
  cleared: number[];
}

/**
 * 运行中出现的组内不支持组合（L7，「待定」4：那个对象不画、提示一次，场景不退回）：`tracked` 是因为它不画的对象 → 键（调用方持有，这里原地改）。
 * 只看这次派生量变了的对象（`result.changed`）与已在 `tracked` 里的：键 = 登记表的组内问题（`result.issues`）加组自身的条件（`groupSelfIssues`）。
 * - 有键：不在 `tracked` 里或键变了的进 `added`（调用方卸 GPU、上报），记进 `tracked`；
 * - 没有键而在 `tracked` 里：摘掉、进 `cleared`（调用方照常装回来）；对象已不在登记表里（删了）只摘、不进 `cleared`。
 * 加载时就有、之后派生量没变过的组内问题不管（只有 dev 强制渲染才走得到这里，那时照画）。
 */
export function trackGroupIssues(
  tracked: Map<number, string[]>,
  result: RestructureResult,
  layers: readonly SceneLayer[],
): GroupIssueChanges {
  const byObject = new Map(layers.map((layer) => [layer.object, layer]));
  const added = new Map<number, string[]>();
  const cleared: number[] = [];
  for (const object of new Set([...result.changed, ...tracked.keys()])) {
    const layer = byObject.get(object);
    if (!layer) {
      tracked.delete(object);
      continue;
    }
    const keys = [...new Set([...(result.issues.get(object) ?? []), ...groupSelfIssues(layer)])].sort();
    const previous = tracked.get(object);
    if (keys.length > 0) {
      if (!previous || previous.join("\n") !== keys.join("\n")) added.set(object, keys);
      tracked.set(object, keys);
    } else if (previous) {
      tracked.delete(object);
      cleared.push(object);
    }
  }
  return { added, cleared };
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
