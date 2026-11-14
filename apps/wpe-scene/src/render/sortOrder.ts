/**
 * 透明排序（P5d 步骤 4，`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 4」）：透视场景开了
 * `general.transparentsorting`（`SceneGeneral.transparentSorting`）时，WPE 的场景绘制函数（`FUN_14018aac0`，rea-p5-mesh 4.2）分两遍画顶层：
 * 1. 按 `objects` 顺序画所有不在半透明名单里的对象；
 * 2. 把半透明名单按「对象**局部** `origin` · 相机前向」从大到小**稳定**排序后画（`FUN_1401865c0` 算键、`FUN_14019ee60` 降序插入排序），
 *    也就是由远到近；模型标志 `fullscreen` / `projectlayer` 的半透明图像层键是 −∞（`obj+0x120` bit9，rea-p5-modelflags 1.4），排在最后。
 * 正交场景、开关关着时照旧按 `objects` 顺序（`p5d-sort-ortho` / `-off`）。名单的成员在编译期定好（`SceneLayer.sortClass`）。
 *
 * 实测依据（p5-REPORT「步骤 4 步骤 0：透明排序」，抓帧 `A:\p5d\sort\`）：前向是视线方向 center − eye（`-rot`）、用局部 origin（`-par`，
 * 父对象的平移不算）、用脚本写回之后的当帧值（`-a` 的 S）、键相同保持原顺序（`-eq`）、`fullscreen` / `projectlayer` 排在最后且两者
 * 保持原顺序（`-fs`）。
 */
import type { SortClass } from "../compile/bundle";
import type { LayerState } from "./state";

/** 排序读的状态：各对象当前的局部 `origin`（`SceneState.layers`，脚本与属性的写入已在里面）。 */
export interface SortState {
  readonly layers: ReadonlyMap<number, Pick<LayerState, "origin">>;
}

/**
 * 一个半透明对象的排序键：`origin · forward`，按 float32 依次乘加（x、y、z，同 WPE 的单精度点积）。`origin` 是对象的局部值（不经父链），
 * `forward` 是相机的视线方向（单位向量）。
 */
export function transparentSortKey(origin: readonly number[], forward: readonly number[]): number {
  const f = Math.fround;
  const x = f(f(origin[0] ?? 0) * f(forward[0] ?? 0));
  const y = f(f(origin[1] ?? 0) * f(forward[1] ?? 0));
  const z = f(f(origin[2] ?? 0) * f(forward[2] ?? 0));
  return f(f(x + y) + z);
}

/**
 * 透明排序后的顶层绘制顺序：先按原顺序放不是 `translucent` / `last` 的（含没有类别的），再放 `translucent` / `last`，按
 * `transparentSortKey(state 里该对象当前的局部 origin, forward)` 从大到小稳定排序，`last` 的键是 −∞。`forward` 是当帧透视相机的视线方向
 * （center − eye，单位向量，float32）。不改 `layers`，返回新数组。
 */
export function transparentDrawOrder<T extends { readonly object: number; readonly sortClass?: SortClass }>(
  layers: readonly T[],
  state: SortState,
  forward: readonly number[],
): T[] {
  const first: T[] = [];
  const sorted: { item: T; key: number }[] = [];
  for (const item of layers) {
    if (item.sortClass !== "translucent" && item.sortClass !== "last") first.push(item);
    else
      sorted.push({
        item,
        key:
          item.sortClass === "last"
            ? -Infinity
            : transparentSortKey(state.layers.get(item.object)?.origin ?? [0, 0, 0], forward),
      });
  }
  // 降序的稳定插入排序（同 WPE `FUN_14019ee60`：比前一个大才往前挪，相等的保持原顺序）
  for (let i = 1; i < sorted.length; i++) {
    const entry = sorted[i];
    let j = i;
    for (; j > 0 && entry.key > sorted[j - 1].key; j--) sorted[j] = sorted[j - 1];
    sorted[j] = entry;
  }
  for (const entry of sorted) first.push(entry.item);
  return first;
}
