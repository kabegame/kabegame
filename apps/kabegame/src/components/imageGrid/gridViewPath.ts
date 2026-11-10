import type { InjectionKey, Ref } from "vue";
import type { GalleryQueryPatch } from "@/utils/galleryPath";
import type { GridAdapterId } from "./types";

/**
 * ImageGrid 提供给插槽内组件（查询行）的当前视图上下文，各页不必再各自传 route store。
 */
export interface GridViewContext {
  /** 当前视图路径（过滤 + 排序，不含分页尾，即 `paged.viewBody`）：「用当前视图轮播」用它。 */
  path: Readonly<Ref<string>>;
  /** 所在页面，即收藏视图的来源（画廊 / 画册 / 任务 / 畅游）。 */
  source: GridAdapterId;
  /** 本页某个查询 / 排序对应的完整视图路径，不导航（route store 的 `computePath`）。 */
  pathFor: (patch: GalleryQueryPatch) => string;
}

export const gridViewKey: InjectionKey<GridViewContext> = Symbol("gridView");
