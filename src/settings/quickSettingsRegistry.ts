import type { Component } from "vue";
import type { AppSettingKey } from "@/stores/settings";
import type { QuickSettingsPageId } from "@/stores/quickSettingsDrawer";

import SettingRow from "@/components/settings/SettingRow.vue";
import SettingSwitchControl from "@/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@/components/settings/controls/SettingNumberControl.vue";
import SettingRadioControl from "@/components/settings/controls/SettingRadioControl.vue";

import DefaultDownloadDirSetting from "@/components/settings/items/DefaultDownloadDirSetting.vue";
import WallpaperEngineDirSetting from "@/components/settings/items/WallpaperEngineDirSetting.vue";
import GalleryImageAspectRatioSetting from "@/components/settings/items/GalleryImageAspectRatioSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";

export type QuickSettingItem = {
  key: AppSettingKey;
  label: string;
  description?: string;
  comp: Component;
  props?: Record<string, any>;
  pages: QuickSettingsPageId[];
};

export type QuickSettingGroup = {
  id: string;
  title: string;
  description?: string;
  items: QuickSettingItem[];
};

/**
 * 快捷设置分组表（key 与后端 AppSettings 的 camelCase 字段完全一致）
 *
 * 注意：
 * - comp 既可以是 “纯控件”（Switch/Select/Number/Radio），也可以是复杂设置项（如目录选择）
 * - pages 决定哪些页面的设置抽屉会展示该项
 */
export const QUICK_SETTINGS_GROUPS: QuickSettingGroup[] = [
  {
    id: "display",
    title: "显示",
    items: [
      {
        key: "galleryImageAspectRatio",
        label: "图片宽高比",
        description: "影响画廊/画册中图片卡片的展示宽高比",
        comp: GalleryImageAspectRatioSetting,
        pages: ["gallery", "albumdetail"],
      },
      {
        key: "imageClickAction",
        label: "双击图片",
        description: "双击图片时的行为",
        comp: SettingRadioControl,
        props: {
          settingKey: "imageClickAction",
          command: "set_image_click_action",
          buildArgs: (value: string) => ({ action: value }),
          options: [
            { label: "应用内预览", value: "preview" },
            { label: "系统默认打开", value: "open" },
          ],
        },
        pages: ["gallery", "albumdetail"],
      },
      {
        key: "galleryPageSize",
        label: "每次加载数量",
        description: "画廊“加载更多”时的加载张数（10-200）",
        comp: SettingNumberControl,
        props: {
          settingKey: "galleryPageSize",
          command: "set_gallery_page_size",
          buildArgs: (value: number) => ({ size: value }),
          min: 10,
          max: 200,
          step: 10,
        },
        pages: ["gallery"],
      },
    ],
  },
  {
    id: "download",
    title: "下载",
    items: [
      {
        key: "maxConcurrentDownloads",
        label: "最大并发下载量",
        description: "同时下载的图片数量（1-10）",
        comp: SettingNumberControl,
        props: {
          settingKey: "maxConcurrentDownloads",
          command: "set_max_concurrent_downloads",
          buildArgs: (value: number) => ({ count: value }),
          min: 1,
          max: 10,
          step: 1,
        },
        pages: ["gallery", "albumdetail"],
      },
      {
        key: "networkRetryCount",
        label: "网络失效重试次数",
        description: "下载图片遇到网络错误/超时等情况时，额外重试次数（0-10）",
        comp: SettingNumberControl,
        props: {
          settingKey: "networkRetryCount",
          command: "set_network_retry_count",
          buildArgs: (value: number) => ({ count: value }),
          min: 0,
          max: 10,
          step: 1,
        },
        pages: ["gallery", "albumdetail"],
      },
      {
        key: "autoDeduplicate",
        label: "自动去重",
        description: "根据文件哈希值自动跳过重复图片",
        comp: SettingSwitchControl,
        props: {
          settingKey: "autoDeduplicate",
          command: "set_auto_deduplicate",
          buildArgs: (value: boolean) => ({ enabled: value }),
        },
        pages: ["gallery", "albumdetail"],
      },
      {
        key: "defaultDownloadDir",
        label: "默认下载目录",
        description:
          "未在任务里指定输出目录时，将下载到该目录（按插件分文件夹保存）",
        comp: DefaultDownloadDirSetting,
        pages: ["gallery", "albumdetail"],
      },
    ],
  },
  {
    id: "wallpaper",
    title: "壁纸",
    items: [
      {
        key: "wallpaperRotationEnabled",
        label: "启用壁纸轮播",
        description: "自动从指定画册中轮播更换桌面壁纸",
        comp: WallpaperRotationEnabledSetting,
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperRotationIntervalMinutes",
        label: "轮播间隔",
        description: "壁纸更换间隔（分钟，1-1440）",
        comp: SettingNumberControl,
        props: {
          settingKey: "wallpaperRotationIntervalMinutes",
          command: "set_wallpaper_rotation_interval_minutes",
          buildArgs: (value: number) => ({ minutes: value }),
          min: 1,
          max: 1440,
          step: 10,
        },
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperRotationMode",
        label: "轮播模式",
        description: "随机：每次随机选择；顺序：按顺序依次更换",
        comp: SettingRadioControl,
        props: {
          settingKey: "wallpaperRotationMode",
          command: "set_wallpaper_rotation_mode",
          buildArgs: (value: string) => ({ mode: value }),
          options: [
            { label: "随机", value: "random" },
            { label: "顺序", value: "sequential" },
          ],
        },
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperRotationStyle",
        label: "壁纸显示方式",
        description:
          "原生模式：根据系统支持显示可用样式；窗口模式：支持所有显示方式",
        comp: WallpaperStyleSetting,
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperRotationTransition",
        label: "过渡效果",
        description: "仅轮播支持过渡预览；原生模式下仅支持无过渡和淡入淡出",
        comp: WallpaperTransitionSetting,
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperMode",
        label: "壁纸模式",
        description:
          "原生模式性能更好；窗口模式更灵活（类似 Wallpaper Engine）",
        comp: WallpaperModeSetting,
        pages: ["gallery", "albumdetail", "albums"],
      },
      {
        key: "wallpaperEngineDir",
        label: "Wallpaper Engine 目录",
        description: "用于“导出并自动导入到 WE”",
        comp: WallpaperEngineDirSetting,
        pages: [],
      },
    ],
  },
  {
    id: "app",
    title: "应用",
    items: [
      {
        key: "autoLaunch",
        label: "开机启动",
        description: "应用启动时自动运行",
        comp: SettingSwitchControl,
        props: {
          settingKey: "autoLaunch",
          command: "set_auto_launch",
          buildArgs: (value: boolean) => ({ enabled: value }),
        },
        pages: ["settings"],
      },
      {
        key: "restoreLastTab",
        label: "恢复上次标签页",
        description: "应用启动时自动恢复到上次访问的标签页",
        comp: SettingSwitchControl,
        props: {
          settingKey: "restoreLastTab",
          command: "set_restore_last_tab",
          buildArgs: (value: boolean) => ({ enabled: value }),
        },
        pages: ["settings"],
      },
    ],
  },
];

// re-export：有些场景会在抽屉里直接复用 SettingRow
export { SettingRow };
