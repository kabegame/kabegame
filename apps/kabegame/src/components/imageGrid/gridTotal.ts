import type { InjectionKey, Ref } from "vue";

/** ImageGrid 提供给插槽内组件的总数，子组件不必再单独订阅同一计数路径。 */
export interface GridTotal {
  total: Readonly<Ref<number>>;
  /** 与 total 同一读快照的不带过滤总数；没有过滤或读失败时为 null。 */
  unfilteredTotal: Readonly<Ref<number | null>>;
}

export const gridTotalKey: InjectionKey<GridTotal> = Symbol("gridTotal");
