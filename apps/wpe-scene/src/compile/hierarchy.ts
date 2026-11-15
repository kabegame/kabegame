/**
 * 对象层级（P4a 步骤 1）：scene.json 的 `parent` 是父对象的 `id`，这里换成父对象的 `objects` 下标。
 *
 * WPE 2.8.42 的语义（2026-11-07 实测，`p4-particles-REPORT.md`「P4a 语义的实测核对」）：
 * - 世界矩阵 `W = W_parent · T · Rz·Ry·Rx · S`（`render/layout.ts` 的 `worldMatrixOf`）；
 * - `visible` 沿父链继承，`alpha`、`color`、`brightness` 不继承；
 * - 绘制顺序就是 `objects` 数组顺序，与父子先后无关，子在父前也成立；
 * - `parent` 指向不存在的 id 时当根节点；没有内容（image / model / particle / sound / text / light）的对象是分组节点，
 *   只有变换。
 */
import { isSceneObject, type SceneObject } from "./model";

export interface ObjectParents {
  /** 按 `objects` 下标：父对象的 `objects` 下标，根节点为 null。环已断开。 */
  parents: (number | null)[];
  /** 父链成环（已断开一条边）：能力表报 `object:parent-cycle`。 */
  cycle: boolean;
}

/**
 * 解析每个对象的父对象。`parent` 只认有限数字，按 `id` 找：不是有限数字、找不到、指向自己时为 null。
 * 成环时把环上指回本轮已走过节点的那条边置 null（从下标小的对象开始走，结果确定）：WPE 的递归没有防环，
 * 这种输入本来就不该有，这里只保证后面沿父链走不会死循环，整张由 `object:parent-cycle` 退回预览图。
 */
export function resolveParents(objects: readonly SceneObject[]): ObjectParents {
  // id → 第一个带这个 id 的对象。id 重复时取第一个：这是没有实测的选择，WPE 遇到重复 id 选哪个没有测过
  const byId = new Map<number, number>();
  objects.forEach((object, index) => {
    const id: unknown = isSceneObject(object) ? object.id : undefined;
    if (typeof id === "number" && Number.isFinite(id) && !byId.has(id)) byId.set(id, index);
  });
  const parents = objects.map((object, index): number | null => {
    const raw = isSceneObject(object) ? object.parent : undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    const found = byId.get(raw);
    return found === undefined || found === index ? null : found;
  });
  return { parents, cycle: breakCycles(parents) };
}

/**
 * 断开父链上的环（原地改 `parents`，返回是否断过）：每个对象最多一个父，沿父链走，碰到本轮正在走的节点就是环，把那条边置 null。
 * `resolveParents` 与运行中换父覆盖之后（P6d3，`bundle.ts`）共用。
 */
export function breakCycles(parents: (number | null)[]): boolean {
  // 0 未访问、1 本轮在走、2 已确定
  const marks = new Uint8Array(parents.length);
  let cycle = false;
  for (let start = 0; start < parents.length; start++) {
    if (marks[start]) continue;
    const path: number[] = [];
    let current: number | null = start;
    while (current !== null && marks[current] === 0) {
      marks[current] = 1;
      path.push(current);
      const next: number | null = parents[current];
      if (next !== null && marks[next] === 1) {
        parents[current] = null;
        cycle = true;
        break;
      }
      current = next;
    }
    for (const index of path) marks[index] = 2;
  }
  return cycle;
}

/**
 * 子表（WPE `O+0x198`，P6d3）：父的 `objects` 下标 → 直接子（`objects` 下标）。没被覆盖过的对象按 `objects` 下标顺序进它的父的子表；
 * 换过父的（`overrides` 按发生先后，同一个对象只取最后一次，位置按最后一次挂上的时刻）追加在新父子表的末尾（步骤 0 实测：挂上的追加在尾）。
 * `parents` 是套用覆盖之后的父（环已断开）：某个被覆盖过的对象最终的父是 null 时不进任何子表；只放非空的表。
 */
export function childLists(
  parents: readonly (number | null)[],
  objectCount: number,
  overrides: readonly (readonly [number, number | null, string | null])[],
): Map<number, number[]> {
  const last = new Map<number, number>();
  overrides.forEach(([object], position) => last.set(object, position));
  const out = new Map<number, number[]>();
  const add = (object: number) => {
    const parent = parents[object];
    if (parent === null || parent === undefined) return;
    const list = out.get(parent);
    if (list) list.push(object);
    else out.set(parent, [object]);
  };
  for (let object = 0; object < objectCount; object++) if (!last.has(object)) add(object);
  for (const [position, [object]] of overrides.entries()) if (last.get(object) === position) add(object);
  return out;
}
