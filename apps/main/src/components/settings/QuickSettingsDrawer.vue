<template>
    <CoreQuickSettingsDrawer :drawer="drawer" :groups="QUICK_SETTINGS_GROUPS" :get-item-disabled="isItemDisabled"
        :get-item-props="getEffectiveProps" :get-item-description="getEffectiveDescription" :drawer-size="drawerSize" />
</template>

<script setup lang="ts">
import { computed, watch, ref } from "vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useSettingsStore, type AppSettingKey } from "@kabegame/core/stores/settings";
import CoreQuickSettingsDrawer from "@kabegame/core/components/settings/QuickSettingsDrawer.vue";
import { QUICK_SETTINGS_GROUPS } from "@/settings/quickSettingsRegistry";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";

const drawer = useQuickSettingsDrawerStore();
const settingsStore = useSettingsStore();
const modalStack = useModalStackStore();
const modalStackId = ref<string | null>(null);

watch(
  () => drawer.isOpen,
  (visible) => {
    if (visible && IS_ANDROID) {
      modalStackId.value = modalStack.push(() => drawer.close());
    } else if (!visible && modalStackId.value) {
      modalStack.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

// 依赖轮播启用的设置项（未启用时应禁用+提示）
const ROTATION_DEPENDENT_KEYS: AppSettingKey[] = [
    "wallpaperRotationIntervalMinutes",
    "wallpaperRotationMode",
    "wallpaperRotationTransition",
];

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

// 计算每个项的禁用状态
const isItemDisabled = (item: any): boolean => {
    if (ROTATION_DEPENDENT_KEYS.includes(item.key)) {
        return !rotationEnabled.value;
    }
    return false;
};

// 获取有效的 props（注入 disabled 状态）
const getEffectiveProps = (item: any, baseProps: Record<string, any>): Record<string, any> => {
    const disabled = isItemDisabled(item);
    return { ...baseProps, disabled: disabled || baseProps.disabled };
};

// 获取有效的描述（未启用时追加提示）
const getEffectiveDescription = (item: any, base: string | undefined): string | undefined => {
    if (ROTATION_DEPENDENT_KEYS.includes(item.key) && !rotationEnabled.value) {
        return base ? `${base}（需先启用壁纸轮播）` : "需先启用壁纸轮播";
    }
    return base;
};
</script>
