import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { QuickSettingsPageId } from "@/stores/quickSettingsDrawer";
import type { QuickSettingGroup, QuickSettingItem } from "@kabegame/core/components/settings/quick-settings-registry-types";
import { IS_ANDROID, IS_LINUX, IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";

import SettingSwitchControl from "@kabegame/core/components/settings/controls/SettingSwitchControl.vue";
import SettingNumberControl from "@kabegame/core/components/settings/controls/SettingNumberControl.vue";
import SettingRadioControl from "@kabegame/core/components/settings/controls/SettingRadioControl.vue";

import DefaultDownloadDirSetting from "@kabegame/core/components/settings/items/DefaultDownloadDirSetting.vue";
import DownloadIntervalSetting from "@/components/settings/items/DownloadIntervalSetting.vue";
import WallpaperEngineDirSetting from "@/components/settings/items/WallpaperEngineDirSetting.vue";
import GalleryImageAspectRatioSetting from "@/components/settings/items/GalleryImageAspectRatioSetting.vue";
import GalleryGridColumnsSetting from "@/components/settings/items/GalleryGridColumnsSetting.vue";
import WallpaperRotationEnabledSetting from "@/components/settings/items/WallpaperRotationEnabledSetting.vue";
import WallpaperModeSetting from "@/components/settings/items/WallpaperModeSetting.vue";
import WallpaperStyleSetting from "@/components/settings/items/WallpaperStyleSetting.vue";
import WallpaperTransitionSetting from "@/components/settings/items/WallpaperTransitionSetting.vue";

/**
 * 使用快捷设置分组：返回已按当前语言翻译的 groups，供 CoreQuickSettingsDrawer 使用。
 * 直接在 computed 内用 t(key) 产出最终结构。
 */
export function useQuickSettingsGroups() {
  const { t } = useI18n();

  const translatedGroups = computed((): QuickSettingGroup<QuickSettingsPageId>[] => [
    {
      id: "display",
      title: t("settings.quickDisplay"),
      items: [
        ...(!IS_ANDROID ? [{
          key: "galleryImageAspectRatio",
          label: t("settings.imageAspectRatio"),
          description: t("settings.imageAspectRatioDesc"),
          comp: GalleryImageAspectRatioSetting,
          pages: ["gallery", "albumdetail"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(!IS_ANDROID ? [{
          key: "imageClickAction",
          label: t("settings.quickDoubleClickImage"),
          description: t("settings.quickDoubleClickImageDesc"),
          comp: SettingRadioControl,
          props: {
            settingKey: "imageClickAction",
            command: "set_image_click_action",
            buildArgs: (value: string) => ({ action: value }),
            options: [
              { label: t("settings.imageClickPreview"), value: "preview" },
              { label: t("settings.imageClickOpen"), value: "open" },
            ],
          },
          pages: ["gallery", "albumdetail"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(!IS_ANDROID ? [{
          key: "galleryGridColumns",
          label: t("settings.quickColumns"),
          description: t("settings.quickColumnsDesc"),
          comp: GalleryGridColumnsSetting,
          pages: ["gallery", "albumdetail"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(!IS_ANDROID ? [{
          key: "galleryImageObjectPosition",
          label: t("settings.imageObjectPosition"),
          description: t("settings.imageObjectPositionDesc"),
          comp: SettingRadioControl,
          props: {
            settingKey: "galleryImageObjectPosition",
            command: "set_gallery_image_object_position",
            buildArgs: (value: string) => ({ position: value }),
            options: [
              { label: t("settings.objectPositionCenter"), value: "center" },
              { label: t("settings.objectPositionTop"), value: "top" },
              { label: t("settings.objectPositionBottom"), value: "bottom" },
            ],
          },
          pages: ["gallery", "albumdetail"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
      ],
    },
    {
      id: "download",
      title: t("settings.quickDownload"),
      items: [
        {
          key: "maxConcurrentDownloads",
          label: t("settings.maxConcurrentDownloads"),
          description: t("settings.maxConcurrentDownloadsDesc"),
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
          key: "downloadIntervalMs",
          label: t("settings.downloadInterval"),
          description: t("settings.downloadIntervalDesc"),
          comp: DownloadIntervalSetting,
          pages: ["gallery", "albumdetail"],
        },
        {
          key: "networkRetryCount",
          label: t("settings.networkRetryCount"),
          description: t("settings.networkRetryCountDesc"),
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
          label: t("settings.autoDeduplicate"),
          description: t("settings.autoDeduplicateDesc"),
          comp: SettingSwitchControl,
          props: {
            settingKey: "autoDeduplicate",
            command: "set_auto_deduplicate",
            buildArgs: (value: boolean) => ({ enabled: value }),
          },
          pages: ["gallery", "albumdetail"],
        },
        ...(!IS_ANDROID ? [{
          key: "defaultDownloadDir",
          label: t("settings.defaultDownloadDir"),
          description: t("settings.defaultDownloadDirDesc"),
          comp: DefaultDownloadDirSetting,
          pages: ["gallery", "albumdetail"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
      ],
    },
    {
      id: "wallpaper",
      title: t("settings.quickWallpaper"),
      items: [
        {
          key: "wallpaperRotationEnabled",
          label: t("settings.wallpaperRotationEnabled"),
          description: t("settings.wallpaperRotationEnabledDesc"),
          comp: WallpaperRotationEnabledSetting,
          pages: ["gallery", "albumdetail", "albums"],
        },
        {
          key: "wallpaperRotationIntervalMinutes",
          label: t("settings.wallpaperRotationInterval"),
          description: t("settings.wallpaperRotationIntervalDesc"),
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
          label: t("settings.wallpaperRotationMode"),
          description: t("settings.wallpaperRotationModeDesc"),
          comp: SettingRadioControl,
          props: {
            settingKey: "wallpaperRotationMode",
            command: "set_wallpaper_rotation_mode",
            buildArgs: (value: string) => ({ mode: value }),
            options: [
              { label: t("settings.wallpaperModeRandom"), value: "random" },
              { label: t("settings.wallpaperModeSequential"), value: "sequential" },
            ],
          },
          pages: ["gallery", "albumdetail", "albums"],
        },
        ...(IS_WINDOWS || IS_LINUX || IS_MACOS ? [{
          key: "wallpaperStyle",
          label: t("settings.wallpaperStyle"),
          description: t("settings.wallpaperStyleDesc"),
          comp: WallpaperStyleSetting,
          pages: ["gallery", "albumdetail", "albums"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(IS_WINDOWS || IS_MACOS ? [{
          key: "wallpaperRotationTransition",
          label: t("settings.wallpaperTransition"),
          description: t("settings.wallpaperTransitionDesc"),
          comp: WallpaperTransitionSetting,
          pages: ["gallery", "albumdetail", "albums"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(IS_WINDOWS || IS_MACOS ? [{
          key: "wallpaperMode",
          label: t("settings.wallpaperModeLabel"),
          description: t("settings.wallpaperModeDesc"),
          comp: WallpaperModeSetting,
          pages: ["gallery", "albumdetail", "albums"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
        ...(IS_WINDOWS ? [{
          key: "wallpaperEngineDir",
          label: t("settings.wallpaperEngineDir"),
          description: t("settings.wallpaperEngineDirDesc"),
          comp: WallpaperEngineDirSetting,
          pages: [],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
      ],
    },
    {
      id: "app",
      title: t("settings.quickApp"),
      items: [
        ...(!IS_ANDROID ? [{
          key: "autoLaunch",
          label: t("settings.autoLaunch"),
          description: t("settings.autoLaunchDesc"),
          comp: SettingSwitchControl,
          props: {
            settingKey: "autoLaunch",
            command: "set_auto_launch",
            buildArgs: (value: boolean) => ({ enabled: value }),
          },
          pages: ["settings"],
        } as QuickSettingItem<QuickSettingsPageId>] : []),
      ],
    },
  ]);

  return { translatedGroups };
}
