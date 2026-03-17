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
import { useI18n } from "vue-i18n";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID, IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t } = useI18n();

type Transition = "none" | "fade" | "slide" | "zoom";
type Opt = { label: string; value: Transition };

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperRotationTransition");
const { wallpaperModeSwitching } = useUiStore();
const settingsStore = useSettingsStore();

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const options = computed<Opt[]>(() => {
  if (mode.value === "native") {
    return [
      { label: t("settings.transitionFollowSystem"), value: "none" },
    ];
  } else if (mode.value === "window" && (IS_WINDOWS || IS_MACOS)) {
    return [
      { label: t("settings.transitionNone"), value: "none" },
      { label: t("settings.transitionFade"), value: "fade" },
      { label: t("settings.transitionSlide"), value: "slide" },
      { label: t("settings.transitionZoom"), value: "zoom" },
    ];
  } else {
    return [
      { label: t("settings.transitionNotImplemented"), value: "none" }
    ];
  }
});

const localValue = ref<string>("none");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "none";
  },
  { immediate: true }
);

onMounted(async () => {
  // 若当前值在 native 模式不可用，做一次本地纠正（保持旧逻辑一致）
  if (mode.value === "native") {
    const unsupported = ["slide", "zoom"];
    const cur = (settingValue.value as any as string) || "none";
    if (unsupported.includes(cur)) {
      settingsStore.values.wallpaperRotationTransition = "none" as any;
      localValue.value = "none";
      if (rotationEnabled.value) {
        try {
          await invoke("set_wallpaper_rotation_transition", { transition: "none" });
        } catch { }
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