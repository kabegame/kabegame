import type { InjectionKey, Ref } from "vue";

/** ImageGrid 提供给插槽内组件的总数，子组件不必再单独订阅同一计数路径。 */
export interface GridTotal {
  total: Readonly<Ref<number>>;
  /** 当前计数路径的数据已到，且最新请求不在途。 */
  settled: Readonly<Ref<boolean>>;
}

export const gridTotalKey: InjectionKey<GridTotal> = Symbol("gridTotal");
