<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="localValue"
    :options="pickerOptions"
    :title="t('settings.styleTitle')"
    :placeholder="t('settings.stylePlaceholder')"
    :disabled="props.disabled || disabled || wallpaperModeSwitching"
    @update:model-value="onPickerChange"
  />
  <el-select
    v-else
    v-model="localValue"
    :placeholder="t('settings.stylePlaceholder')"
    style="min-width: 180px"
    :disabled="props.disabled || disabled || wallpaperModeSwitching"
    @change="handleChange"
  >
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value">
      <span>{{ opt.desc }}</span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID, IS_LINUX, IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";
import { useDesktop } from "@/composables/useDesktop";
import { useUiStore } from "@kabegame/core/stores/ui";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t } = useI18n();

type Style = "fill" | "fit" | "stretch" | "center" | "tile" | "system";
type Opt = { label: string; value: Style; desc: string };

const ALL_STYLES: Style[] = ["fill", "fit", "stretch", "center", "tile"];

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperStyle");
const settingsStore = useSettingsStore();
const { wallpaperModeSwitching } = useUiStore();
const { isPlasma } = useDesktop();

const nativeWallpaperStyles = computed<Style[]>(() => {
  if (IS_WINDOWS) return [...ALL_STYLES];
  if (IS_MACOS) return [];
  if (IS_LINUX) return isPlasma.value ? ["fill", "fit", "center", "tile"] : [...ALL_STYLES];
  if (IS_ANDROID) return ["fill"];
  return ["fill"];
});

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");

const styleOptions = computed<Opt[]>(() => [
  { label: t("settings.styleFill"), value: "fill", desc: t("settings.styleFillDesc") },
  { label: t("settings.styleFit"), value: "fit", desc: t("settings.styleFitDesc") },
  { label: t("settings.styleStretch"), value: "stretch", desc: t("settings.styleStretchDesc") },
  { label: t("settings.styleCenter"), value: "center", desc: t("settings.styleCenterDesc") },
  { label: t("settings.styleTile"), value: "tile", desc: t("settings.styleTileDesc") },
]);

const systemOpt = computed<Opt>(() => ({
  label: t("settings.styleSystem"),
  value: "system",
  desc: t("settings.styleSystemDesc"),
}));

const options = computed(() => {
  const list =
    (mode.value === "window" && (IS_WINDOWS || IS_MACOS)) || mode.value === "plasma-plugin"
      ? styleOptions.value
      : styleOptions.value.filter((o) => nativeWallpaperStyles.value.includes(o.value as Style));
  return [systemOpt.value, ...list];
});

const pickerOptions = computed(() =>
  options.value.map((o) => ({ label: o.label, value: o.value }))
);

const localValue = ref<string>("system");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "system";
  },
  { immediate: true }
);

const handleChange = async (style: string) => {
  // 特殊逻辑：不再等待事件，因为方法会在设置完毕后返回，等待事件会导致时序问题
  const onAfterSave = async () => {
    return;
  };

  await set(style, onAfterSave);
};

const onPickerChange = async (v: string | null) => {
  await handleChange(v ?? "system");
};
</script>