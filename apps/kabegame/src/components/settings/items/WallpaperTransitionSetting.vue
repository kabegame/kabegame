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
    <!-- 下拉宽度已统一为输入框宽度，长文案会被 ellipsis 截断；补原生 title 让鼠标能看全 -->
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" :title="opt.label" />
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore } from "@/stores/settings";
import { IS_ANDROID } from "@/env";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";

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
  })),
);

const localValue = ref<string>("none");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "none";
  },
  { immediate: true },
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
