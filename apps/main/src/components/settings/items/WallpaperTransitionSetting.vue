<template>
  <el-select v-model="localValue" placeholder="请选择过渡效果" style="min-width: 180px"
    :disabled="props.disabled || wallpaperModeSwitching || disabled" @change="handleChange">
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WINDOWS } from "@kabegame/core/env";

const props = defineProps<{
  disabled?: boolean;
}>();

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
      { label: "跟随系统", value: "none" },
    ];
  } else if (mode.value === "window" && IS_WINDOWS) {
    return [
      { label: "无过渡", value: "none" },
      { label: "淡入淡出", value: "fade" },
      { label: "滑动切换", value: "slide" },
      { label: "缩放淡入", value: "zoom" },
    ];
  } else {
    // 其他系统的非原生，暂未实现
    return [
      { label: "（未实现）", value: "none" }
    ]
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
  // 如果轮播未启用，给出提示但不阻止设置
  if (!rotationEnabled.value) {
    ElMessage.info("未启用轮播：过渡效果将在启用轮播后生效");
  }

  await set(transition);
};
</script>