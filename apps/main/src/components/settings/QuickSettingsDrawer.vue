<template>
    <CoreQuickSettingsDrawer :is-open="drawer.isOpen" :title="drawerTitle" :page-id="drawer.pageId" :groups="translatedGroups" :get-item-disabled="isItemDisabled"
        :get-item-props="getEffectiveProps" :get-item-description="getEffectiveDescription" :drawer-size="drawerSize"
        :empty-description="t('settings.quickEmpty')" @on-close="drawer.close" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useQuickSettingsDrawerStore, getQuickSettingsDrawerTitleKey } from "@/stores/quickSettingsDrawer";
import { useSettingsStore, type AppSettingKey } from "@kabegame/core/stores/settings";
import CoreQuickSettingsDrawer from "@kabegame/core/components/settings/QuickSettingsDrawer.vue";
import { useQuickSettingsGroups } from "@/settings/quickSettingsRegistry";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

const { t } = useI18n();
const drawer = useQuickSettingsDrawerStore();
const settingsStore = useSettingsStore();
const { translatedGroups } = useQuickSettingsGroups();

const quickSettingsOpen = computed({
  get: () => drawer.isOpen,
  set: (v) => { if (!v) drawer.close(); },
});
useModalBack(quickSettingsOpen);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

const drawerTitle = computed(() => t(getQuickSettingsDrawerTitleKey(drawer.pageId)));

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
