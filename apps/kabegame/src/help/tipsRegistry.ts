import type { Component } from "vue";
import { i18n } from "@kabegame/i18n";
import TipImportDragDrop from "@/help/tips/gallery/TipImportDragDrop.vue";
import TipGalleryBrowsing from "@/help/tips/gallery/TipGalleryBrowsing.vue";
import TipGalleryPreview from "@/help/tips/gallery/TipGalleryPreview.vue";
import TipPluginIntroduction from "@/help/tips/plugins/TipPluginIntroduction.vue";
import TipPluginStoreBasics from "@/help/tips/plugins/TipPluginStoreBasics.vue";
import TipPluginImport from "@/help/tips/plugins/TipPluginImport.vue";
import TipPluginUsage from "@/help/tips/plugins/TipPluginUsage.vue";
import TipEasterEggTurtleComplaint from "@/help/tips/easter-egg/TipEasterEggTurtleComplaint.vue";
import TipTrayIntroduction from "@/help/tips/tray/TipTrayIntroduction.vue";
import TipVirtualDriveBasics from "@/help/tips/virtual-driver/TipVirtualDriveBasics.vue";
import TipVirtualDriveDirectories from "@/help/tips/virtual-driver/TipVirtualDriveDirectories.vue";
import TipCommandLineBasics from "@/help/tips/command-line/TipCommandLineBasics.vue";
import TipCommandLineExamples from "@/help/tips/command-line/TipCommandLineExamples.vue";
import TipAlbumsIntroduction from "@/help/tips/albums/TipAlbumsIntroduction.vue";
import TipWallpaperBasic from "@/help/tips/wallpaper/TipWallpaperBasic.vue";
import TipWallpaperRotation from "@/help/tips/wallpaper/TipWallpaperRotation.vue";
import TipWallpaperMode from "@/help/tips/wallpaper/TipWallpaperMode.vue";
import TipWallpaperWindowVideo from "@/help/tips/wallpaper/TipWallpaperWindowVideo.vue";
import TipTaskViewing from "@/help/tips/tasks/TipTaskViewing.vue";
import TipTaskManagement from "@/help/tips/tasks/TipTaskManagement.vue";
import TipTaskIntroduction from "@/help/tips/tasks/TipTaskIntroduction.vue";

import { IS_ANDROID, IS_LIGHT_MODE } from "@kabegame/core/env";

type TranslateFn = (key: string) => string;

function getLightModeTags(t: TranslateFn) {
  if (IS_ANDROID) {
    return [{ text: t("help.tips.tag.androidUnavailable"), type: "danger" as const }];
  }
  if (IS_LIGHT_MODE) {
    return [{ text: t("help.tips.tag.lightModeUnavailable"), type: "danger" as const }];
  }
  return [];
}

export type TipCategoryId =
  | "gallery"
  | "albums"
  | "plugins"
  | "easter-egg"
  | "tray"
  | "virtual-driver"
  | "command-line"
  | "wallpaper"
  | "tasks";

export type TipId =
  | "import-drag-drop"
  | "gallery-browsing"
  | "gallery-preview"
  | "albums-introduction"
  | "plugin-introduction"
  | "plugin-store-basics"
  | "plugin-import"
  | "plugin-usage"
  | "easter-egg-turtle-complaint"
  | "tray-introduction"
  | "virtual-driver-basics"
  | "virtual-driver-directories"
  | "command-line-basics"
  | "command-line-examples"
  | "wallpaper-basic"
  | "wallpaper-rotation"
  | "wallpaper-mode"
  | "wallpaper-window-video"
  | "task-introduction"
  | "task-viewing"
  | "task-management";

export type Tip = {
  id: TipId;
  title: string;
  summary: string;
  /** 详情组件（复杂 HTML 详情用这个；否则回落到 detail 文本结构） */
  component?: Component;
  /** 详情（简单段落结构；可作为兜底/也可用于简单技巧） */
  detail?: {
    sections: Array<{
      title: string;
      paragraphs: string[];
      bullets?: string[];
      note?: string;
    }>;
  };
  tags?: Array<{
    text: string;
    type: "success" | "warning" | "danger" | "info";
  }>;
};

export type TipCategory = {
  id: TipCategoryId;
  title: string; // 目录名
  description?: string;
  tags?: Array<{
    text: string;
    type: "success" | "warning" | "danger" | "info";
  }>;
  tips: Tip[]; // 该分类下的所有技巧
};

export function getTipCategories(t: TranslateFn): TipCategory[] {
  const lightTags = getLightModeTags(t);
  return [
    {
      id: "gallery",
      title: t("help.tips.category.gallery.title"),
      description: t("help.tips.category.gallery.description"),
    tips: [
      {
        id: "import-drag-drop",
        title: t("help.tips.item.import-drag-drop.title"),
        summary: t("help.tips.item.import-drag-drop.summary"),
        component: TipImportDragDrop,
      },
      {
        id: "gallery-browsing",
        title: t("help.tips.item.gallery-browsing.title"),
        summary: t("help.tips.item.gallery-browsing.summary"),
        component: TipGalleryBrowsing,
      },
      {
        id: "gallery-preview",
        title: t("help.tips.item.gallery-preview.title"),
        summary: t("help.tips.item.gallery-preview.summary"),
        component: TipGalleryPreview,
      },
    ],
  },
  {
    id: "albums",
    title: t("help.tips.category.albums.title"),
    description: t("help.tips.category.albums.description"),
    tips: [
      {
        id: "albums-introduction",
        title: t("help.tips.item.albums-introduction.title"),
        summary: t("help.tips.item.albums-introduction.summary"),
        component: TipAlbumsIntroduction,
      },
    ],
  },
  {
    id: "wallpaper",
    title: t("help.tips.category.wallpaper.title"),
    description: t("help.tips.category.wallpaper.description"),
    tips: [
      {
        id: "wallpaper-basic",
        title: t("help.tips.item.wallpaper-basic.title"),
        summary: t("help.tips.item.wallpaper-basic.summary"),
        component: TipWallpaperBasic,
      },
      {
        id: "wallpaper-rotation",
        title: t("help.tips.item.wallpaper-rotation.title"),
        summary: t("help.tips.item.wallpaper-rotation.summary"),
        component: TipWallpaperRotation,
      },
      {
        id: "wallpaper-mode",
        title: t("help.tips.item.wallpaper-mode.title"),
        summary: t("help.tips.item.wallpaper-mode.summary"),
        component: TipWallpaperMode,
      },
      {
        id: "wallpaper-window-video",
        title: t("help.tips.item.wallpaper-window-video.title"),
        summary: t("help.tips.item.wallpaper-window-video.summary"),
        component: TipWallpaperWindowVideo,
      },
    ],
  },
  {
    id: "plugins",
    title: t("help.tips.category.plugins.title"),
    description: t("help.tips.category.plugins.description"),
    tips: [
      {
        id: "plugin-introduction",
        title: t("help.tips.item.plugin-introduction.title"),
        summary: t("help.tips.item.plugin-introduction.summary"),
        component: TipPluginIntroduction,
      },
      {
        id: "plugin-store-basics",
        title: t("help.tips.item.plugin-store-basics.title"),
        summary: t("help.tips.item.plugin-store-basics.summary"),
        component: TipPluginStoreBasics,
      },
      {
        id: "plugin-import",
        title: t("help.tips.item.plugin-import.title"),
        summary: t("help.tips.item.plugin-import.summary"),
        component: TipPluginImport,
      },
      {
        id: "plugin-usage",
        title: t("help.tips.item.plugin-usage.title"),
        summary: t("help.tips.item.plugin-usage.summary"),
        component: TipPluginUsage,
      },
    ],
  },
  {
    id: "tasks",
    title: t("help.tips.category.tasks.title"),
    description: t("help.tips.category.tasks.description"),
    tips: [
      {
        id: "task-introduction",
        title: t("help.tips.item.task-introduction.title"),
        summary: t("help.tips.item.task-introduction.summary"),
        component: TipTaskIntroduction,
      },
      {
        id: "task-viewing",
        title: t("help.tips.item.task-viewing.title"),
        summary: t("help.tips.item.task-viewing.summary"),
        component: TipTaskViewing,
      },
      {
        id: "task-management",
        title: t("help.tips.item.task-management.title"),
        summary: t("help.tips.item.task-management.summary"),
        component: TipTaskManagement,
      },
    ],
  },
  {
    id: "tray",
    title: t("help.tips.category.tray.title"),
    description: t("help.tips.category.tray.description"),
    tips: [
      {
        id: "tray-introduction",
        title: t("help.tips.item.tray-introduction.title"),
        summary: t("help.tips.item.tray-introduction.summary"),
        component: TipTrayIntroduction,
      },
    ],
  },
  {
    id: "virtual-driver",
    title: t("help.tips.category.virtual-driver.title"),
    description: t("help.tips.category.virtual-driver.description"),
    tags: lightTags,
    tips: [
      {
        id: "virtual-driver-basics",
        title: t("help.tips.item.virtual-driver-basics.title"),
        summary: t("help.tips.item.virtual-driver-basics.summary"),
        component: TipVirtualDriveBasics,
        tags: lightTags,
      },
      {
        id: "virtual-driver-directories",
        title: t("help.tips.item.virtual-driver-directories.title"),
        summary: t("help.tips.item.virtual-driver-directories.summary"),
        component: TipVirtualDriveDirectories,
        tags: lightTags,
      },
    ],
  },
  {
    id: "command-line",
    title: t("help.tips.category.command-line.title"),
    description: t("help.tips.category.command-line.description"),
    tags: lightTags,
    tips: [
      {
        id: "command-line-basics",
        title: t("help.tips.item.command-line-basics.title"),
        summary: t("help.tips.item.command-line-basics.summary"),
        component: TipCommandLineBasics,
        tags: lightTags,
      },
      {
        id: "command-line-examples",
        title: t("help.tips.item.command-line-examples.title"),
        summary: t("help.tips.item.command-line-examples.summary"),
        component: TipCommandLineExamples,
        tags: lightTags,
      },
    ],
  },
  {
    id: "easter-egg",
    title: t("help.tips.category.easter-egg.title"),
    description: t("help.tips.category.easter-egg.description"),
    tips: [
      {
        id: "easter-egg-turtle-complaint",
        title: t("help.tips.item.easter-egg-turtle-complaint.title"),
        summary: t("help.tips.item.easter-egg-turtle-complaint.summary"),
        component: TipEasterEggTurtleComplaint,
      },
    ],
  },
  ];
}

/** @deprecated Use getTipCategories(t) for locale-aware categories */
export const TIP_CATEGORIES = getTipCategories(i18n.global.t);
