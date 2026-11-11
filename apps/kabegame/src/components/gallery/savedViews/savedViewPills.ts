import { markRaw, type Component } from "vue";
import { Search } from "@kabegame/element-plus-icons";
import { FILTER_DIMENSION_ICONS } from "@/components/gallery/galleryChipIcons";
import {
  galleryDimensionChipValue,
  gallerySearchModeLabel,
  type GalleryLabelContext,
} from "@/utils/galleryFilterLabels";
import { DIMENSION_ORDER, type GalleryFilterSet, type GalleryQuery } from "@/utils/galleryQuery";

/** 组合展示里的一颗只读条件：一个维度的一个取值。 */
export interface SavedViewPill {
  /** 维度 + 取值：差异对比按它判断「新增 / 将移除」。 */
  key: string;
  icon: Component;
  label: string;
  title: string;
  /** 跟在 label 后面的小色块（CSS 颜色）与它的名字：按颜色排序时用。 */
  swatch?: string;
  swatchLabel?: string;
}

const SEARCH_ICON = markRaw(Search);

/** 一个查询原子（各维度之间是「且」）拆成逐维度的条件。 */
export function filterSetPills(set: GalleryFilterSet, ctx: GalleryLabelContext): SavedViewPill[] {
  const pills: SavedViewPill[] = [];
  const search = set.search;
  if (search?.query.trim()) {
    const modes = search.modes.map((mode) => gallerySearchModeLabel(mode, ctx.t)).join(" / ");
    pills.push({
      key: `search:${JSON.stringify(search)}`,
      icon: SEARCH_ICON,
      label: search.query,
      title: modes ? `${search.query} · ${modes}` : search.query,
    });
  }
  for (const dimension of DIMENSION_ORDER) {
    const label = galleryDimensionChipValue(dimension, set, ctx);
    if (label === undefined) continue;
    pills.push({
      key: `${dimension}:${JSON.stringify(set[dimension])}`,
      icon: FILTER_DIMENSION_ICONS[dimension],
      label,
      title: label,
    });
  }
  return pills;
}

/** 整棵查询摊平成条件列表（不分位置）：差异对比用。 */
export function queryPills(query: GalleryQuery, ctx: GalleryLabelContext): SavedViewPill[] {
  const out: SavedViewPill[] = [];
  const walk = (nodes: GalleryQuery) => {
    for (const node of nodes) {
      if ("is" in node) out.push(...filterSetPills(node.is, ctx));
      else if ("any" in node) node.any.forEach(walk);
      else walk(node.not);
    }
  };
  walk(query);
  return out;
}
