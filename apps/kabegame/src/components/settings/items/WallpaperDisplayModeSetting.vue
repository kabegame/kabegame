<template>
  <KbSegmentedControl
    :model-value="localValue"
    :options="options"
    :disabled="switching"
    @update:model-value="handleChange"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import { useWallpaperDisplayMode } from "@/composables/useWallpaperTarget";
import { logger } from "@/utils/logger";
import type { WallpaperDisplayMode } from "@/utils/wallpaperTargets";
import KbSegmentedControl from "@/components/common/form/KbSegmentedControl.vue";

/**
 * 显示器模式（各屏复制 / 跨屏拼接 / 逐屏独立）。
 *
 * 选项、可不可选、不可选的原因全部来自后端能力表里当前壁纸模式的那一组，这里不写平台判断：
 * 不可选的项置灰、悬停显示原因。能力表只列一项时（Android、Plasma 插件模式）没有可选的余地，
 * 由设置页整行不显示。
 */
const props = defineProps<{
  disabled?: boolean;
}>();

const { locale } = useI18n();
const settingsStore = useSettingsStore();
const uiStore = useUiStore();
const capabilities = useWallpaperCapabilities();
const { disabled: settingBusy, set } = useSettingKeyState("wallpaperDisplayMode");
/** 实际生效的模式：设置里的值在当前壁纸模式下不可用时是 multiple */
const displayMode = useWallpaperDisplayMode();

const wallpaperMode = computed(() => settingsStore.values.wallpaperMode || "native");

const options = computed(() =>
  capabilities.displayModesFor(wallpaperMode.value).map((combo) => ({
    value: combo.value,
    label: resolveManifestText(combo.label, locale.value),
    disabled: !!combo.unavailable,
    // 可选的项悬停说明这个模式做什么，不可选的说明为什么
    tip: resolveManifestText(combo.unavailable ?? combo.desc, locale.value) || undefined,
  })),
);

const saving = ref(false);
const switching = computed(
  () => props.disabled || saving.value || settingBusy.value || uiStore.wallpaperModeSwitching === true,
);

const localValue = ref<string>("multiple");
watch(
  displayMode,
  (mode) => {
    localValue.value = mode;
  },
  { immediate: true },
);

const handleChange = async (mode: string) => {
  if (switching.value) return;
  const previous = localValue.value;
  // 切换要重排壁纸输出，期间控件禁用；先把选中框挪过去，失败再挪回来
  localValue.value = mode;
  saving.value = true;
  try {
    // 成功后新值由后端的 setting-change 落到设置里（可能比命令返回晚一点），选中框先停在新值上
    const accepted = await set(mode as WallpaperDisplayMode);
    // 写入被拒（设置还在加载 / 保存中）时没有事件把选中框带回来
    if (!accepted) localValue.value = previous;
  } catch (error) {
    logger.warn("切换显示器模式失败:", error);
    // 后端的错误信息就是不可用的原因
    kameMessage.error(error instanceof Error ? error.message : String(error));
    localValue.value = previous;
  } finally {
    saving.value = false;
  }
};
</script>
