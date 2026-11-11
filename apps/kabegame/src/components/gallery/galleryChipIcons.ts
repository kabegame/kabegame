import { markRaw, type Component } from "vue";
import {
  Clock,
  FilterAspect,
  FilterColor,
  FilterDate,
  FilterMedia,
  FilterName,
  FilterPlugin,
  FilterSize,
  FilterWallpaper,
  List,
  MagicStick,
  Rank,
} from "@kabegame/element-plus-icons";
import type { GalleryBrowseDimension, GallerySortField } from "@/utils/galleryPath";

/**
 * 查询行与收藏视图组合展示共用的 chip 图标。
 * 搜索有独立输入组件（GallerySearchDropdown），不进维度图标表。
 * 过滤维度图标与高级查询弹窗同源（设计稿那套 16px 线性图标）。
 */
export const FILTER_DIMENSION_ICONS: Record<GalleryBrowseDimension, Component> = {
  plugin: markRaw(FilterPlugin),
  mediaType: markRaw(FilterMedia),
  date: markRaw(FilterDate),
  size: markRaw(FilterSize),
  aspect: markRaw(FilterAspect),
};

/**
 * 排序维度的图标。纯图标 chip 下，通用的「排序」双箭头说不出到底按什么排，
 * 所以每个维度用它自己那张脸——与同名过滤维度共用一张，认过一次就都认得。
 */
export const SORT_FIELD_ICONS: Record<GallerySortField, Component> = {
  "by-id": markRaw(Rank),
  "by-time": markRaw(Clock),
  "by-size": markRaw(FilterSize),
  "by-name": markRaw(FilterName),
  "by-aspect": markRaw(FilterAspect),
  "by-set-time": markRaw(FilterWallpaper),
  "by-album-order": markRaw(List),
  random: markRaw(MagicStick),
  // 两个颜色字段在界面上是同一个维度，共用调色板
  "by-color": markRaw(FilterColor),
  "by-any-color": markRaw(FilterColor),
};
