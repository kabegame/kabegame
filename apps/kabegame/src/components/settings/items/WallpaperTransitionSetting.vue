<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="localValue"
    :options="options"
    :title="t('settings.transitionTitle')"
    :placeholder="t('settings.transitionPlaceholder')"
    :disabled="props.disabled || wallpaperModeSwitching || disabled"
    @update:model-value="(v) => handleChange(v ?? 'none')"
  />
  <el-select
    v-else
    v-model="localValue"
    :placeholder="t('settings.transitionPlaceholder')"
    style="min-width: 180px"
    :disabled="props.disabled || wallpaperModeSwitching || disabled"
    @change="handleChange"
  >
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID } from "@kabegame/core/env";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t, locale } = useI18n();

const { settingValue, disabled, set } = useSettingKeyState("wallpaperRotationTransition");
const { wallpaperModeSwitching } = useUiStore();
const settingsStore = useSettingsStore();
const capabilities = useWallpaperCapabilities();

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const options = computed(() =>
  capabilities.transitionsFor(mode.value).map((opt) => ({
    value: opt.value,
    label: resolveManifestText(opt.label, locale.value),
  }))
);

const localValue = ref<string>("none");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "none";
  },
  { immediate: true }
);

onMounted(async () => {
  await capabilities.load();
  const cur = (settingValue.value as any as string) || "none";
  const values = options.value.map((opt) => opt.value);
  if (values.length > 0 && !values.includes(cur)) {
    const fallback = values[0] ?? "none";
    settingsStore.values.wallpaperRotationTransition = fallback as any;
    localValue.value = fallback;
    if (rotationEnabled.value) {
      try {
        await invoke("set_wallpaper_rotation_transition", { transition: fallback });
      } catch {
        // 后端纠正失败时保留本地回退，等待下一次设置同步。
      }
    }
  }
});

const handleChange = async (transition: string) => {
  if (!rotationEnabled.value) {
    ElMessage.info(t("settings.transitionRotationRequired"));
  }
  await set(transition);
};
</script>
