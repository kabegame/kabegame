<template>
  <el-select v-model="localValue" placeholder="请选择过渡效果" style="min-width: 180px" :disabled="disabled"
    @change="handleChange">
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { useSettingsUiStore } from "@/stores/settingsUi";

type Transition = "none" | "fade" | "slide" | "zoom";
type Opt = { label: string; value: Transition };

const settingsStore = useSettingsStore();
const uiStore = useSettingsUiStore();

const isApplying = ref(false);
const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const options = computed<Opt[]>(() => {
  if (mode.value === "native") {
    return [
      { label: "无过渡", value: "none" },
      { label: "淡入淡出", value: "fade" },
    ];
  }
  return [
    { label: "无过渡", value: "none" },
    { label: "淡入淡出（推荐）", value: "fade" },
    { label: "滑动切换", value: "slide" },
    { label: "缩放淡入", value: "zoom" },
  ];
});

const disabled = computed(() => {
  if (uiStore.wallpaperModeSwitching) return true;
  if (isApplying.value) return true;
  // 单张壁纸模式不支持过渡（后端会拒绝），前端直接禁用
  if (!rotationEnabled.value) return true;
  return false;
});

const localValue = ref<string>("none");
watch(
  () => settingsStore.values.wallpaperRotationTransition,
  (v) => {
    localValue.value = (v as any as string) || "none";
  },
  { immediate: true }
);

onMounted(async () => {
  // 若当前值在 native 模式不可用，做一次本地纠正（保持旧逻辑一致）
  if (mode.value === "native") {
    const unsupported = ["slide", "zoom"];
    const cur = (settingsStore.values.wallpaperRotationTransition as any as string) || "none";
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
    ElMessage.info("未启用轮播：过渡效果不会生效");
    return;
  }
  if (disabled.value) return;

  isApplying.value = true;
  const prev = settingsStore.values.wallpaperRotationTransition as any;
  settingsStore.values.wallpaperRotationTransition = transition as any;
  settingsStore.savingByKey.wallpaperRotationTransition = true;
  try {
    const waitForApply = new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      const unlistenFn = await listen<{ success: boolean; transition: string; error?: string }>(
        "wallpaper-transition-apply-complete",
        (event) => {
          if (event.payload.transition === transition) {
            unlistenFn();
            resolve({ success: event.payload.success, error: event.payload.error });
          }
        }
      );
    });

    await invoke("set_wallpaper_rotation_transition", { transition });

    const result = await waitForApply;
    if (!result.success) ElMessage.error(result.error || "应用过渡效果失败");
  } catch (e) {
    settingsStore.values.wallpaperRotationTransition = prev;
    localValue.value = (prev as any as string) || "none";
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    settingsStore.savingByKey.wallpaperRotationTransition = false;
    isApplying.value = false;
  }
};
</script>
