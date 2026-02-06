import type { Component } from "vue";
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
import TipTaskViewing from "@/help/tips/tasks/TipTaskViewing.vue";
import TipTaskManagement from "@/help/tips/tasks/TipTaskManagement.vue";
import TipTaskIntroduction from "@/help/tips/tasks/TipTaskIntroduction.vue";

import { IS_LIGHT_MODE } from "@kabegame/core/env";

const lightModeTags = IS_LIGHT_MODE
  ? [{ text: "Light 模式不可用", type: "danger" as const }]
  : [];

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

export const TIP_CATEGORIES: TipCategory[] = [
  {
    id: "gallery",
    title: "画廊",
    description: "查看和管理收集到的图片",
    tips: [
      {
        id: "import-drag-drop",
        title: "拖入本地文件快速导入",
        summary:
          "把图片/文件夹/压缩包直接拖到窗口里，一键导入到画廊（可选同时创建画册）。",
        component: TipImportDragDrop,
      },
      {
        id: "gallery-browsing",
        title: "画廊浏览方法",
        summary:
          "了解如何查看图片总数、使用分页浏览大量图片，以及使用去重功能清理重复图片。",
        component: TipGalleryBrowsing,
      },
      {
        id: "gallery-preview",
        title: "双击应用内预览",
        summary:
          "启用后双击图片即可在应用内查看大图，支持缩放、拖拽、切换图片等操作，无需打开系统图片查看器。",
        component: TipGalleryPreview,
      },
    ],
  },
  {
    id: "albums",
    title: "画册",
    description: "创建和管理画册，整理和分类图片",
    tips: [
      {
        id: "albums-introduction",
        title: "画册说明",
        summary:
          "画册用于整理和分类图片，可以创建画册、添加图片、设为壁纸轮播等。",
        component: TipAlbumsIntroduction,
      },
    ],
  },
  {
    id: "wallpaper",
    title: "壁纸",
    description: "设置桌面壁纸、轮播和显示模式",
    tips: [
      {
        id: "wallpaper-basic",
        title: "基本壁纸设置方法",
        summary: "右键图片选择「抱到桌面上」，快速设置单张壁纸。",
        component: TipWallpaperBasic,
      },
      {
        id: "wallpaper-rotation",
        title: "轮播 vs 非轮播",
        summary: "了解轮播模式和非轮播模式的区别，以及如何开启/关闭轮播。",
        component: TipWallpaperRotation,
      },
      {
        id: "wallpaper-mode",
        title: "原生模式 vs 窗口模式",
        summary: "两种壁纸显示模式的区别：原生模式性能好，窗口模式功能更丰富。",
        component: TipWallpaperMode,
      },
    ],
  },
  {
    id: "plugins",
    title: "插件",
    description: "源插件的安装、商店源与插件编辑器",
    tips: [
      {
        id: "plugin-introduction",
        title: "什么是插件？",
        summary:
          "插件是 Kabegame 的核心功能，用于从各种网站收集图片资源。了解插件的基本概念、文件格式、类型和作用。",
        component: TipPluginIntroduction,
      },
      {
        id: "plugin-store-basics",
        title: "插件商店与商店源怎么用",
        summary:
          '在"源管理"里安装/更新源插件，并通过添加商店源获得可安装列表。',
        component: TipPluginStoreBasics,
      },
      {
        id: "plugin-import",
        title: "插件导入方法",
        summary:
          "四种方式导入 .kgpg 插件文件：双击文件、拖入窗口、从源管理页面导入、通过插件编辑器编写并导入。",
        component: TipPluginImport,
      },
      {
        id: "plugin-usage",
        title: "如何使用插件收集图片",
        summary:
          "在画廊页面打开收集对话框，选择插件、配置参数、设置输出目录和画册，然后开始收集任务。",
        component: TipPluginUsage,
      },
    ],
  },
  {
    id: "tasks",
    title: "任务",
    description: "查看和管理收集任务",
    tips: [
      {
        id: "task-introduction",
        title: "任务说明",
        summary:
          "了解任务是什么、任务做了什么，以及最大运行任务数量和并发下载限制。",
        component: TipTaskIntroduction,
      },
      {
        id: "task-viewing",
        title: "查看任务信息、状态以及图片",
        summary:
          "了解如何通过任务抽屉和任务详情页查看任务信息、状态以及已收集的图片。",
        component: TipTaskViewing,
      },
      {
        id: "task-management",
        title: "任务的创建、删除和终止方法",
        summary:
          "了解如何创建收集任务、终止正在运行的任务，以及删除任务（包括批量删除）。",
        component: TipTaskManagement,
      },
    ],
  },
  {
    id: "tray",
    title: "托盘",
    description: "系统托盘图标的位置和功能说明",
    tips: [
      {
        id: "tray-introduction",
        title: "托盘位置及功能",
        summary:
          "了解系统托盘图标的位置、左键/右键功能，以及托盘菜单的各项功能。",
        component: TipTrayIntroduction,
      },
    ],
  },
  {
    id: "virtual-driver",
    title: "虚拟盘（VD）",
    description: "在资源管理器里像磁盘一样浏览画册（Windows）",
    tags: lightModeTags,
    tips: [
      {
        id: "virtual-driver-basics",
        title: "用虚拟盘在资源管理器里浏览图片",
        summary: "开启“画册盘”后，可在资源管理器中文件方式浏览画册与图片文件。",
        component: TipVirtualDriveBasics,
        tags: lightModeTags,
      },
      {
        id: "virtual-driver-directories",
        title: "虚拟盘各目录说明",
        summary:
          "了解虚拟盘根目录下的各个目录（全部、按插件、按时间、按任务、画册）的用途和使用场景。",
        component: TipVirtualDriveDirectories,
        tags: lightModeTags,
      },
    ],
  },
  {
    id: "command-line",
    title: "命令行",
    description: "使用命令行工具运行插件、打包和导入插件",
    tags: lightModeTags,
    tips: [
      {
        id: "command-line-basics",
        title: "命令行基本说明",
        summary:
          "了解 Kabegame CLI 工具的基本用法，包括如何运行插件、打包插件和导入插件。",
        component: TipCommandLineBasics,
        tags: lightModeTags,
      },
      {
        id: "command-line-examples",
        title: "常用命令示例",
        summary:
          "实用的命令行操作示例：导入单张图片、导入文件夹到画廊等常用场景。",
        component: TipCommandLineExamples,
        tags: lightModeTags,
      },
    ],
  },
  {
    id: "easter-egg",
    title: "彩蛋",
    description: "一些不影响功能的小惊喜",
    tips: [
      {
        id: "easter-egg-turtle-complaint",
        title: "快速滑动会触发龟龟的埋怨",
        summary: "在画廊/画册里滑得太快，会出现「龟龟跟不上」的俏皮提示。",
        component: TipEasterEggTurtleComplaint,
      },
    ],
  },
];
