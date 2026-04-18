import { defineStore } from "pinia";
import { shallowReactive } from "vue";
import type { Component } from "vue";

export enum HeaderFeatureId {
  Help = "help",
  QuickSettings = "quickSettings",
  Refresh = "refresh",
  StopTask = "stopTask",
  DeleteTask = "deleteTask",
  Organize = "organize",
  Collect = "collect",
  CreateAlbum = "createAlbum",
  OpenVirtualDrive = "openVirtualDrive",
  SetAsWallpaperCarousel = "setAsWallpaperCarousel",
  DeleteAlbum = "deleteAlbum",
  ImportSource = "importSource",
  ManageSources = "manageSources",
  TaskDrawer = "taskDrawer",
  /** 任务详情页：查看任务日志（Android 放入 fold） */
  TaskViewLog = "taskViewLog",
  /** 任务详情页：查看运行参数（Android 放入 fold） */
  TaskViewParams = "taskViewParams",
  FailedImages = "failedImages",
  AddToAlbum = "addToAlbum",
  /** 画廊：过滤（全部 / 设置过壁纸等，仅 Android 放入 fold） */
  GalleryFilter = "galleryFilter",
  /** 画廊「全部」下按时间排序（仅 Android 放入 fold，点击后打开 van-picker） */
  GallerySort = "gallerySort",
  /** 画廊每页条数（仅 Android 放入 fold） */
  GalleryPageSize = "galleryPageSize",
  /** 画册详情：过滤（全部 / 设过壁纸），Android 放入 fold */
  AlbumBrowseFilter = "albumBrowseFilter",
  /** 画册详情：排序，Android 放入 fold */
  AlbumBrowseSort = "albumBrowseSort",
  /** 畅游页：打开爬虫 WebView 窗口（仅桌面） */
  OpenCrawlerWebview = "openCrawlerWebview",
  /** 失败图片页：取消等待；Android 放入 fold */
  FailedImagesCancelWaiting = "failedImagesCancelWaiting",
  /** 失败图片页：全部重试；Android 放入 fold */
  FailedImagesRetryAll = "failedImagesRetryAll",
  /** 失败图片页：全部删除；Android 放入 fold */
  FailedImagesDeleteAll = "failedImagesDeleteAll",
  /** 失败图片页：按插件筛选；Android 放入 fold */
  FailedImagesFilter = "failedImagesFilter",
}

export interface HeaderFeatureDef {
  id: HeaderFeatureId;
  label?: string;     // fold 下拉菜单显示用；show 模式下作为 tooltip
  icon?: Component;   // fold 下拉菜单图标；无 comp 时用于 show 模式默认按钮
  comp?: Component;   // 自定义组件（show 模式专用）；缺失时自动用 icon+label 生成 HeaderActionButton
}

export const useHeaderStore = defineStore('header', () => {
  const features = new Map<string, HeaderFeatureDef>();
  /** fold 项 label 覆盖，浅响应式；未覆盖时用 register 的 feature.label */
  const foldLabels = shallowReactive<Record<string, string>>({});

  function register(defs: HeaderFeatureDef[]) {
    for (const def of defs) {
      features.set(def.id, def);
    }
  }

  function get(id: HeaderFeatureId | string): HeaderFeatureDef | undefined {
    return features.get(id);
  }

  function has(id: HeaderFeatureId | string): boolean {
    return features.has(id);
  }

  /** 设置或清除某 feature 的 fold 文案覆盖；label 为 undefined 时恢复为 register 时的 label */
  function setFoldLabel(id: HeaderFeatureId | string, label: string | undefined) {
    if (label === undefined) {
      delete foldLabels[id];
    } else {
      foldLabels[id] = label;
    }
  }

  function getFoldLabel(id: HeaderFeatureId | string): string {
    if (id in foldLabels) return foldLabels[id];
    const feature = features.get(id);
    return feature?.label ?? id;
  }

  return {
    register,
    get,
    has,
    setFoldLabel,
    getFoldLabel,
  };
});