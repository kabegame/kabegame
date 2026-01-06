<template>
  <el-select v-model="localValue" placeholder="请选择显示方式" style="min-width: 180px" :disabled="disabled"
    @change="handleChange">
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value">
      <span>{{ opt.desc }}</span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

type Style = "fill" | "fit" | "stretch" | "center" | "tile";
type Opt = { label: string; value: Style; desc: string };

const settingsStore = useSettingsStore();
const uiStore = useUiStore();

const isApplying = ref(false);
const nativeWallpaperStyles = ref<Style[]>([]);

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");

const disabled = computed(() => uiStore.wallpaperModeSwitching || isApplying.value);

const allOptions: Opt[] = [
  { label: "填充", value: "fill", desc: "填充 - 保持宽高比，填满屏幕（可能裁剪）" },
  { label: "适应", value: "fit", desc: "适应 - 保持宽高比，完整显示（可能有黑边）" },
  { label: "拉伸", value: "stretch", desc: "拉伸 - 拉伸填满屏幕（可能变形）" },
  { label: "居中", value: "center", desc: "居中 - 原始大小居中显示" },
  { label: "平铺", value: "tile", desc: "平铺 - 重复平铺显示" },
];

const options = computed(() => {
  if (mode.value === "window") return allOptions;
  if (!nativeWallpaperStyles.value.length) return allOptions;
  return allOptions.filter((o) => nativeWallpaperStyles.value.includes(o.value));
});

const localValue = ref<string>("fill");
watch(
  () => settingsStore.values.wallpaperRotationStyle,
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
  if (disabled.value) return;
  isApplying.value = true;
  const prev = settingsStore.values.wallpaperRotationStyle as any;
  settingsStore.values.wallpaperRotationStyle = style as any;
  settingsStore.savingByKey.wallpaperRotationStyle = true;

  try {
    const waitForApply = new Promise<{ success: boolean; error?: string }>(async (resolve) => {
      const unlistenFn = await listen<{ success: boolean; style: string; error?: string }>(
        "wallpaper-style-apply-complete",
        (event) => {
          if (event.payload.style === style) {
            unlistenFn();
            resolve({ success: event.payload.success, error: event.payload.error });
          }
        }
      );
    });

    // 触发保存 + 后台应用（命令会立即返回）
    await invoke("set_wallpaper_style", { style });

    const result = await waitForApply;
    if (!result.success) ElMessage.error(result.error || "应用样式失败");
  } catch (e) {
    settingsStore.values.wallpaperRotationStyle = prev;
    localValue.value = (prev as any as string) || "fill";
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    settingsStore.savingByKey.wallpaperRotationStyle = false;
    isApplying.value = false;
  }
};
</script>
