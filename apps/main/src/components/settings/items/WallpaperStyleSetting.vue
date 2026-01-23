<template>
  <el-select v-model="localValue" placeholder="请选择显示方式" style="min-width: 180px" :disabled="props.disabled || disabled"
    @change="handleChange">
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value">
      <span>{{ opt.desc }}</span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WINDOWS } from "@kabegame/core/env";

const props = defineProps<{
  disabled?: boolean;
}>();

type Style = "fill" | "fit" | "stretch" | "center" | "tile";
type Opt = { label: string; value: Style; desc: string };

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperRotationStyle");
const settingsStore = useSettingsStore();

const nativeWallpaperStyles = ref<Style[]>([]);

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");

const allOptions: Opt[] = [
  { label: "填充", value: "fill", desc: "填充 - 保持宽高比，填满屏幕（可能裁剪）" },
  { label: "适应", value: "fit", desc: "适应 - 保持宽高比，完整显示（可能有黑边）" },
  { label: "拉伸", value: "stretch", desc: "拉伸 - 拉伸填满屏幕（可能变形）" },
  { label: "居中", value: "center", desc: "居中 - 原始大小居中显示" },
  { label: "平铺", value: "tile", desc: "平铺 - 重复平铺显示" },
];

const options = computed(() => {
  if (mode.value === "window" && IS_WINDOWS) return allOptions;
  if (!nativeWallpaperStyles.value.length) return allOptions;
  return allOptions.filter((o) => nativeWallpaperStyles.value.includes(o.value));
});

const localValue = ref<string>("fill");
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string) || "fill";
  },
  { immediate: true }
);

onMounted(async () => {
  try {
    nativeWallpaperStyles.value = (await invoke<string[]>("get_native_wallpaper_styles")) as any;
  } catch {
    nativeWallpaperStyles.value = ["fill", "fit", "stretch", "center", "tile"];
  }
});

const handleChange = async (style: string) => {
  // 特殊逻辑：等待壁纸应用完成
  const onAfterSave = async () => {
    return new Promise<void>((resolve, reject) => {
      const waitForApply = async () => {
        try {
          const unlistenFn = await listen<{ success: boolean; style: string; error?: string }>(
            "wallpaper-style-apply-complete",
            (event) => {
              if (event.payload.style === style) {
                unlistenFn();
                if (!event.payload.success) {
                  ElMessage.error(event.payload.error || "应用样式失败");
                  reject(new Error(event.payload.error || "应用样式失败"));
                } else {
                  resolve();
                }
              }
            }
          );
        } catch (e) {
          reject(e);
        }
      };

      waitForApply();
    });
  };

  await set(style, onAfterSave);
};
</script>