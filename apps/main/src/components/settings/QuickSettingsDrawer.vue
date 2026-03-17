<template>
    <CoreQuickSettingsDrawer :drawer="drawer" :groups="translatedGroups" :get-item-disabled="isItemDisabled"
        :get-item-props="getEffectiveProps" :get-item-description="getEffectiveDescription" :drawer-size="drawerSize" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useSettingsStore, type AppSettingKey } from "@kabegame/core/stores/settings";
import CoreQuickSettingsDrawer from "@kabegame/core/components/settings/QuickSettingsDrawer.vue";
import { QUICK_SETTINGS_GROUPS } from "@/settings/quickSettingsRegistry";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

const { t } = useI18n();
const drawer = useQuickSettingsDrawerStore();
const settingsStore = useSettingsStore();

const quickSettingsOpen = computed({
  get: () => drawer.isOpen,
  set: (v) => { if (!v) drawer.close(); },
});
useModalBack(quickSettingsOpen);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

const GROUP_TITLE_KEYS: Record<string, string> = {
  display: "settings.quickDisplay",
  download: "settings.quickDownload",
  wallpaper: "settings.quickWallpaper",
  app: "settings.quickApp",
};

const ITEM_LABEL_KEYS: Record<string, string> = {
  galleryImageAspectRatio: "settings.imageAspectRatio",
  imageClickAction: "settings.quickDoubleClickImage",
  galleryGridColumns: "settings.quickColumns",
  galleryImageObjectPosition: "settings.imageObjectPosition",
  maxConcurrentDownloads: "settings.maxConcurrentDownloads",
  downloadIntervalMs: "settings.downloadInterval",
  networkRetryCount: "settings.networkRetryCount",
  autoDeduplicate: "settings.autoDeduplicate",
  defaultDownloadDir: "settings.defaultDownloadDir",
  wallpaperRotationEnabled: "settings.wallpaperRotationEnabled",
  wallpaperRotationIntervalMinutes: "settings.wallpaperRotationInterval",
  wallpaperRotationMode: "settings.wallpaperRotationMode",
  wallpaperStyle: "settings.wallpaperStyle",
  wallpaperRotationTransition: "settings.wallpaperTransition",
  wallpaperMode: "settings.wallpaperModeLabel",
  wallpaperEngineDir: "settings.wallpaperEngineDir",
  autoLaunch: "settings.autoLaunch",
};

const ITEM_DESC_KEYS: Record<string, string> = {
  galleryImageAspectRatio: "settings.imageAspectRatioDesc",
  imageClickAction: "settings.quickDoubleClickImageDesc",
  galleryGridColumns: "settings.quickColumnsDesc",
  galleryImageObjectPosition: "settings.imageObjectPositionDesc",
  maxConcurrentDownloads: "settings.maxConcurrentDownloadsDesc",
  downloadIntervalMs: "settings.downloadIntervalDesc",
  networkRetryCount: "settings.networkRetryCountDesc",
  autoDeduplicate: "settings.autoDeduplicateDesc",
  defaultDownloadDir: "settings.defaultDownloadDirDesc",
  wallpaperRotationEnabled: "settings.wallpaperRotationEnabledDesc",
  wallpaperRotationIntervalMinutes: "settings.wallpaperRotationIntervalDesc",
  wallpaperRotationMode: "settings.wallpaperRotationModeDesc",
  wallpaperStyle: "settings.wallpaperStyleDesc",
  wallpaperRotationTransition: "settings.wallpaperTransitionDesc",
  wallpaperMode: "settings.wallpaperModeDesc",
  wallpaperEngineDir: "settings.wallpaperEngineDirDesc",
  autoLaunch: "settings.autoLaunchDesc",
};

const OPTION_LABEL_KEYS: Record<string, string> = {
  preview: "settings.imageClickPreview",
  open: "settings.imageClickOpen",
  center: "settings.objectPositionCenter",
  top: "settings.objectPositionTop",
  bottom: "settings.objectPositionBottom",
  random: "settings.wallpaperModeRandom",
  sequential: "settings.wallpaperModeSequential",
};

const translatedGroups = computed(() =>
  QUICK_SETTINGS_GROUPS.map((g) => ({
    ...g,
    title: t(GROUP_TITLE_KEYS[g.id] || g.title),
    items: g.items.map((i) => ({
      ...i,
      label: t(ITEM_LABEL_KEYS[i.key] || i.label),
      description: t(ITEM_DESC_KEYS[i.key] || i.description || ""),
      props: i.props?.options
        ? { ...i.props, options: i.props.options.map((o: { value: string; label: string }) => ({ ...o, label: t(OPTION_LABEL_KEYS[o.value] || o.label) })) }
        : i.props,
    })),
  }))
);

const ROTATION_DEPENDENT_KEYS: AppSettingKey[] = [
    "wallpaperRotationIntervalMinutes",
    "wallpaperRotationMode",
    "wallpaperRotationTransition",
];

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const isItemDisabled = (item: any): boolean => {
    if (ROTATION_DEPENDENT_KEYS.includes(item.key)) {
        return !rotationEnabled.value;
    }
    return false;
};

const getEffectiveProps = (item: any, baseProps: Record<string, any>): Record<string, any> => {
    const disabled = isItemDisabled(item);
    return { ...baseProps, disabled: disabled || baseProps.disabled };
};

const getEffectiveDescription = (item: any, base: string | undefined): string | undefined => {
    if (ROTATION_DEPENDENT_KEYS.includes(item.key) && !rotationEnabled.value) {
        return base ? `${base}${t("settings.quickRotationDependent")}` : t("settings.quickRotationDependent");
    }
    return base;
};
</script>
