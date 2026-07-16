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
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID } from "@kabegame/core/env";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t, locale } = useI18n();

const { settingValue, disabled, set } = useSettingKeyState("wallpaperStyle");
const settingsStore = useSettingsStore();
const { wallpaperModeSwitching } = useUiStore();
const capabilities = useWallpaperCapabilities();

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");

const options = computed(() =>
  capabilities.stylesFor(mode.value).map((opt) => ({
    value: opt.value,
    label: resolveManifestText(opt.label, locale.value),
    desc: resolveManifestText(opt.desc, locale.value),
  }))
);

const pickerOptions = computed(() =>
  options.value.map((o) => ({ label: o.label, value: o.value }))
);

const localValue = ref<string>("fill");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "fill";
  },
  { immediate: true }
);

const handleChange = async (style: string) => {
  await set(style);
};

const onPickerChange = async (v: string | null) => {
  await handleChange(v ?? "fill");
};
</script>
