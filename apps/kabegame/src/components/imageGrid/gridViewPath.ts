import type { InjectionKey, Ref } from "vue";

/**
 * ImageGrid 提供给插槽内组件的当前视图路径（过滤 + 排序，不含分页尾，即 `paged.viewBody`）。
 * 查询行据此「用当前视图轮播」，各页不必再各自传 route store 的路径。
 */
export const gridViewPathKey: InjectionKey<Readonly<Ref<string>>> = Symbol("gridViewPath");
