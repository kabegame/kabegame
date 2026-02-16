import { MoreFilled, QuestionFilled, Setting, Refresh, Filter, Plus, FolderOpened, Picture, Delete, Upload, Grid } from "@element-plus/icons-vue";
import type { Component } from "vue";
import { IS_ANDROID, IS_LIGHT_MODE, IS_LOCAL_MODE } from "@kabegame/core/env";

/**
 * 页面 ID，用于标识 header 功能出现在哪些页面
 */
export type HeaderPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "pluginbrowser"
  | "taskdetail"
  | "settings"
  | "help";

/**
 * Header 功能 ID
 */
export type HeaderFeatureId =
  | "help"
  | "quickSettings"
  | "refresh"
  | "dedupe"
  | "collect"
  | "createAlbum"
  | "openVirtualDrive"
  | "openVirtualDriveAlbumFolder"
  | "setAsWallpaperCarousel"
  | "deleteAlbum"
  | "importSource"
  | "manageSources";

/**
 * Header 功能配置
 */
export interface HeaderFeature {
  /** 功能 ID */
  id: HeaderFeatureId;
  /** 显示标签 */
  label: string;
  /** 图标组件 */
  icon: Component;
  /** 出现在哪些页面 */
  pages: HeaderPageId[];
  /** 是否折叠到溢出菜单（使用侧根据平台判断是否应用） */
  fold: boolean;
  /** 是否隐藏（完全不显示，使用侧根据平台和模式判断是否应用） */
  hide: boolean;
  /** 排序顺序（数字越小越靠前） */
  order: number;
}

/**
 * Header 功能注册表
 * 
 * 规则：
 * - 每个功能指定出现在哪些页面（pages）
 * - 如果hide为true则一定不出现，否则可能在调用侧出现
 * - 如果fold为true则折叠到溢出菜单
 * - order 控制菜单项顺序（数字越小越靠前）
 */
export const headerFeatures: HeaderFeature[] = [
  // 帮助
  {
    id: "help",
    label: "帮助",
    icon: QuestionFilled,
    pages: IS_ANDROID ? [] : ["gallery", "albums", "albumdetail", "pluginbrowser", "taskdetail", "settings"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 100,
  },
  // 快捷设置
  {
    id: "quickSettings",
    label: "快捷设置",
    icon: Setting,
    pages: ["gallery", "albums", "albumdetail", "pluginbrowser", "taskdetail"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 101,
  },
  // 刷新
  {
    id: "refresh",
    label: "刷新",
    icon: Refresh,
    pages: ["gallery", "albums", "albumdetail", "pluginbrowser", "taskdetail"],
    fold: false,
    hide: IS_ANDROID, // Android 下隐藏刷新功能
    order: 10,
  },
  // 去重（Gallery 专用）
  {
    id: "dedupe",
    label: "去重",
    icon: Filter,
    pages: ["gallery"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 20,
  },
  // 收集（Gallery 专用）
  {
    id: "collect",
    label: "收集",
    icon: Plus,
    pages: ["gallery"],
    fold: false, // Android 下主操作，保持直显
    hide: false,
    order: 1,
  },
  // 新建画册（Albums 专用）
  {
    id: "createAlbum",
    label: "新建画册",
    icon: Plus,
    pages: ["albums"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 30,
  },
  // 去VD查看（Albums 专用）
  // 在非 light 且非 Android 下 hide=true
  {
    id: "openVirtualDrive",
    label: "去VD查看",
    icon: FolderOpened,
    pages: ["albums"],
    fold: true, // Android 下折叠
    hide: !IS_LIGHT_MODE && !IS_ANDROID, // 在非 light 且非 Android 下隐藏
    order: 31,
  },
  // 去VD查看（AlbumDetail 专用）
  // 在非 light 且非 Android 下 hide=true
  {
    id: "openVirtualDriveAlbumFolder",
    label: "去VD查看",
    icon: FolderOpened,
    pages: ["albumdetail"],
    fold: IS_ANDROID, // Android 下折叠
    hide: !IS_LIGHT_MODE && !IS_ANDROID, // 在非 light 且非 Android 下隐藏
    order: 40,
  },
  // 设为轮播壁纸（AlbumDetail 专用）
  {
    id: "setAsWallpaperCarousel",
    label: "设为轮播壁纸",
    icon: Picture,
    pages: ["albumdetail"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 41,
  },
  // 删除画册（AlbumDetail 专用）
  {
    id: "deleteAlbum",
    label: "删除画册",
    icon: Delete,
    pages: ["albumdetail"],
    fold: IS_ANDROID, // Android 下折叠
    hide: false,
    order: 42,
  },
  // 导入源（PluginBrowser 专用）
  {
    id: "importSource",
    label: "导入源",
    icon: Upload,
    pages: ["pluginbrowser"],
    fold: false,
    hide: false,
    order: 2,
  },
  // 管理源（PluginBrowser 专用）
  // 仅在桌面 normal 或 Android 下可用（即 local/light 模式下 hide=true，除非是 Android）
  {
    id: "manageSources",
    label: "管理源",
    icon: Grid,
    pages: ["pluginbrowser"],
    fold: IS_ANDROID, // Android 下折叠
    hide: (IS_LOCAL_MODE || IS_LIGHT_MODE) && !IS_ANDROID, // local/light 模式下隐藏，除非是 Android
    order: 50,
  },
];

/**
 * 根据页面 ID 获取该页面的所有功能
 */
export function getFeaturesForPage(pageId: HeaderPageId): HeaderFeature[] {
  return headerFeatures.filter((f) => f.pages.includes(pageId));
}

/**
 * 判断指定功能是否存在于指定页面
 * 
 * 根据 pages 列表严格判断功能是否存在，不依赖 hide 字段。
 * 
 * @param pageId 页面 ID
 * @param featureId 功能 ID
 * @returns 功能是否存在于该页面
 */
export function hasFeatureInPage(
  pageId: HeaderPageId,
  featureId: HeaderFeatureId
): boolean {
  const feature = headerFeatures.find((f) => f.id === featureId);
  return feature ? feature.pages.includes(pageId) : false;
}

/**
 * 根据页面 ID 获取应该显示的功能
 * 
 * 注意：此函数只根据 pages 过滤功能是否存在，不过滤 hide。
 * hide 字段仅控制图标显示，不影响功能存在性（功能可能通过其他方式访问，如下拉刷新）。
 * 使用侧应根据 hide 字段决定是否显示图标。
 * 
 * @param pageId 页面 ID
 * @returns 应该显示的功能列表（已排序，包含 hide=true 的功能）
 */
export function getVisibleFeaturesForPage(
  pageId: HeaderPageId
): HeaderFeature[] {
  const features = getFeaturesForPage(pageId);
  // 只根据 pages 过滤，不过滤 hide（hide 只影响显示，不影响功能存在性）
  return features.sort((a, b) => a.order - b.order);
}

/**
 * 根据页面 ID 获取应该折叠到溢出菜单的功能
 * 
 * 注意：此函数会过滤掉 hide=true 的功能，因为隐藏的功能不应该出现在菜单中。
 * 
 * @param pageId 页面 ID
 * @returns 应该折叠的功能列表（已排序，不包含 hide=true 的功能）
 */
export function getFoldedFeaturesForPage(
  pageId: HeaderPageId
): HeaderFeature[] {
  const features = getVisibleFeaturesForPage(pageId);
  // 折叠菜单中不显示隐藏的功能
  return features.filter((f) => !f.hide && f.fold).sort((a, b) => a.order - b.order);
}

/**
 * 根据页面 ID 获取应该直显的功能
 * 
 * 注意：此函数会过滤掉 hide=true 的功能，因为隐藏的功能不应该显示为按钮。
 * 
 * @param pageId 页面 ID
 * @returns 应该直显的功能列表（已排序，不包含 hide=true 的功能）
 */
export function getDirectFeaturesForPage(
  pageId: HeaderPageId
): HeaderFeature[] {
  const features = getVisibleFeaturesForPage(pageId);
  // 直显按钮中不显示隐藏的功能
  return features.filter((f) => !f.hide && !f.fold).sort((a, b) => a.order - b.order);
}

