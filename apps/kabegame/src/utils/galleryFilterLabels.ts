/**
 * 画廊过滤 / 排序的文案口径——工具栏（`GalleryToolbar` 的安卓折叠菜单标签）与
 * 查询行（`GalleryQueryBar` 的 chip、picker）共用一份，避免两处各自漂移。
 *
 * chip 与折叠菜单的差别只在**要不要带维度名前缀**：
 * - `galleryDimensionChipValue`：只给纯值（维度名已经画在 chip 左侧）。
 * - `galleryLabelForFilter`：带「按插件：」这类前缀，用于没有维度名的折叠菜单标签。
 */
import {
  GALLERY_ASPECT_BUCKETS,
  filterAspectRange,
  filterDateSegment,
  filterForDimension,
  filterMediaFormat,
  filterMediaKind,
  filterPluginId,
  filterSizeRange,
  type GalleryFilter,
  type GalleryBrowseDimension,
  type GalleryFilterSet,
  type GallerySortField,
} from "./galleryPath";
import type { GallerySearchPathMode } from "./galleryQuery";
import { formatTimeFilterDetail } from "./galleryTimeFilterMenu";
import { facetValueLabel, mediaFormatLabel } from "@/composables/useAdvancedQueryFacets";

type TFn = (key: string, named?: any) => string;

export interface GalleryLabelContext {
  t: TFn;
  /** 当前语言：日期文案按它格式化，同时作为 computed 的依赖锚点。 */
  locale: string;
  /** 插件 id → 展示名，一般传 `usePluginStore().pluginLabel`。 */
  pluginLabel: (pluginId: string) => string;
}

const SIZE_RANGE_LABEL_KEYS: Record<string, string> = {
  unknown: "filterSize_unknown",
  "1B-512KB": "filterSize_lt512k",
  "512KB-1MB": "filterSize_512k_1m",
  "1MB-2MB": "filterSize_1m_2m",
  "2MB-5MB": "filterSize_2m_5m",
  "5MB-10MB": "filterSize_5m_10m",
  "10MB-50MB": "filterSize_10m_50m",
  "50MB-": "filterSize_gte50m",
};

const ASPECT_RANGE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  GALLERY_ASPECT_BUCKETS.map((b) => [b.range, b.labelKey]),
);

export function gallerySortFieldLabel(field: GallerySortField, t: TFn): string {
  switch (field) {
    case "by-id":
      return t("gallery.sortByDefault");
    case "by-time":
      return t("gallery.sortByTime");
    case "by-size":
      return t("gallery.sortBySize");
    case "by-name":
      return t("gallery.sortByName");
    case "by-aspect":
      return t("gallery.sortByAspect");
    case "by-set-time":
      return t("gallery.sortBySetTime");
    case "by-album-order":
      return t("gallery.byAlbumDefaultSort");
    case "random":
      return t("gallery.sortByRandom");
    // 两个颜色字段在界面上是同一个维度
    case "by-color":
    case "by-any-color":
      return t("gallery.sortByColor");
  }
}

/** `colorLabel` 需要的色桶信息：基本色桶带名称键（`red` 等），用户保存的色桶没有。 */
export interface ColorBucketLabelSource {
  hex: string;
  key?: string | null;
}

/**
 * 一个颜色的显示名：基本色桶用它的名字（「红」），其它颜色（用户保存的色桶、没保存的颜色）用 `#rrggbb`。
 * `hex` 是六位小写十六进制，不带前缀。
 */
export function colorLabel(hex: string, buckets: readonly ColorBucketLabelSource[], t: TFn): string {
  const key = buckets.find((bucket) => bucket.hex === hex)?.key;
  return key ? t(`gallery.colorBucket.${key}`) : `#${hex}`;
}

/** 搜索维度（勾选项）的名字：搜索下拉与收藏视图的组合展示共用。 */
export function gallerySearchModeLabel(mode: GallerySearchPathMode, t: TFn): string {
  if (mode === "metadata") return t("gallery.searchModeMetadata");
  if (mode === "native-metadata") return t("gallery.searchModeNativeMetadata");
  if (mode === "local-path") return t("gallery.searchModeLocalPath");
  if (mode === "url") return t("gallery.searchModeUrl");
  if (mode === "label") return t("gallery.searchModeLabel");
  return t("gallery.searchModeDisplayName");
}

/** 某个排序维度下「升序 / 降序」各自的完整说法（安卓 picker 与折叠菜单标签用）。 */
export function gallerySortOrderLabels(field: GallerySortField, t: TFn): { asc: string; desc: string } {
  switch (field) {
    case "by-id":
      return { asc: t("gallery.byDefaultAsc"), desc: t("gallery.byDefaultDesc") };
    case "by-set-time":
      return { asc: t("gallery.bySetTimeAsc"), desc: t("gallery.bySetTimeDesc") };
    case "by-name":
      return { asc: t("gallery.byNameAsc"), desc: t("gallery.byNameDesc") };
    case "by-size":
      return { asc: t("gallery.bySizeAsc"), desc: t("gallery.bySizeDesc") };
    case "by-aspect":
      return {
        asc: t("gallery.byAspectWidthHeight"),
        desc: t("gallery.byAspectHeightWidth"),
      };
    case "by-time":
      return { asc: t("gallery.byTimeAsc"), desc: t("gallery.byTimeDesc") };
    case "by-album-order":
      return {
        asc: t("gallery.byAlbumDefaultSort"),
        desc: t("gallery.byAlbumDefaultSort"),
      };
    case "random":
      return { asc: t("gallery.byRandomAsc"), desc: t("gallery.byRandomDesc") };
    case "by-color":
    case "by-any-color":
      return { asc: t("gallery.byColorAsc"), desc: t("gallery.byColorDesc") };
  }
}

/** 带维度名前缀的完整说法：给没有 chip 承载维度名的地方（安卓折叠菜单）用。 */
export function galleryLabelForFilter(filter: GalleryFilter | GalleryFilterSet, ctx: GalleryLabelContext): string {
  const { t, locale, pluginLabel } = ctx;
  const single = filter as GalleryFilter;
  const sr = filterSizeRange(filter);
  if (sr !== null) {
    const key = SIZE_RANGE_LABEL_KEYS[sr];
    return `${t("gallery.filterBySize")}: ${key ? t(`gallery.${key}`) : sr}`;
  }
  const ar = filterAspectRange(filter);
  if (ar !== null) {
    const key = ASPECT_RANGE_LABEL_KEYS[ar];
    return `${t("gallery.filterByAspect")}: ${key ? t(`gallery.${key}`) : ar}`;
  }
  if (single.type === "date-range") {
    return `${single.start} ~ ${single.end}`;
  }
  const dt = filterDateSegment(filter);
  if (dt) {
    return t("gallery.filterByTimeWithDetail", {
      detail: formatTimeFilterDetail(dt, locale, t),
    });
  }
  const pid = filterPluginId(filter);
  if (pid) {
    const ext = single.type === "plugin" ? single.extendPath?.trim() : "";
    const name = pluginLabel(pid);
    return ext ? `${name} / ${ext}` : t("gallery.filterByPluginWithName", { name });
  }
  const mk = filterMediaKind(filter);
  const mf = filterMediaFormat(filter);
  if (mk) {
    const label = facetValueLabel("mediaType", mk, t);
    return mf ? `${label} / ${mediaFormatLabel(mk, mf, t)}` : label;
  }
  return t("gallery.filterAll");
}

/**
 * chip 上只显示纯值：维度名已经在 chip 左侧，「按插件：」这类前缀在那里是冗余的。
 * 取值口径与高级查询弹窗一致（`facetValueLabel`）。未选中该维度时返回 undefined。
 */
export function galleryDimensionChipValue(
  dimension: GalleryBrowseDimension,
  filters: GalleryFilterSet,
  ctx: GalleryLabelContext,
): string | undefined {
  const { t, locale, pluginLabel } = ctx;
  const filter = filterForDimension(filters, dimension);
  if (filter.type === "all") return undefined;
  if (dimension === "plugin") {
    const pid = filterPluginId(filter);
    if (!pid) return undefined;
    const ext = filter.type === "plugin" ? filter.extendPath?.trim() : "";
    const name = pluginLabel(pid);
    return ext ? `${name} / ${ext}` : name;
  }
  if (dimension === "date") {
    if (filter.type === "date-range") return `${filter.start} ~ ${filter.end}`;
    const segment = filterDateSegment(filter);
    return segment ? formatTimeFilterDetail(segment, locale, t) : undefined;
  }
  if (dimension === "mediaType") {
    const kind = filterMediaKind(filter);
    if (!kind) return undefined;
    const format = filterMediaFormat(filter);
    const label = facetValueLabel("mediaType", kind, t);
    return format ? `${label} / ${mediaFormatLabel(kind, format, t)}` : label;
  }
  const value = dimension === "size" ? filterSizeRange(filter) : filterAspectRange(filter);
  if (value == null) return undefined;
  return facetValueLabel(dimension, value, t);
}
