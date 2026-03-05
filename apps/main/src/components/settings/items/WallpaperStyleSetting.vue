<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="localValue"
    :options="pickerOptions"
    title="壁纸显示方式"
    placeholder="请选择显示方式"
    :disabled="props.disabled || disabled || wallpaperModeSwitching"
    @update:model-value="onPickerChange"
  />
  <el-select
    v-else
    v-model="localValue"
    placeholder="请选择显示方式"
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
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID, IS_LINUX, IS_MACOS, IS_PLASMA, IS_WINDOWS } from "@kabegame/core/env";
import { useUiStore } from "@kabegame/core/stores/ui";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";

const props = defineProps<{
  disabled?: boolean;
}>();

type Style = "fill" | "fit" | "stretch" | "center" | "tile" | "system";
type Opt = { label: string; value: Style; desc: string };

const SYSTEM_OPT: Opt = {
  label: "按照系统",
  value: "system",
  desc: "按照系统 - 根据系统设置显示",
};

const ALL_STYLES: Style[] = ["fill", "fit", "stretch", "center", "tile"];

/** 根据当前运行环境返回原生壁纸支持的填充模式列表 */
function getNativeWallpaperStyles(): Style[] {
  if (IS_WINDOWS) return [...ALL_STYLES];
  if (IS_MACOS) return [];
  if (IS_LINUX) return IS_PLASMA ? ["fill", "fit", "center", "tile"] : [...ALL_STYLES];
  if (IS_ANDROID) return ["fill"];
  return ["fill"];
}

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperStyle");
const settingsStore = useSettingsStore();
const { wallpaperModeSwitching } = useUiStore();

const nativeWallpaperStyles = computed<Style[]>(() => getNativeWallpaperStyles());

const mode = computed(() => (settingsStore.values.wallpaperMode as any as string) || "native");

const styleOptions: Opt[] = [
  { label: "填充", value: "fill", desc: "填充 - 保持宽高比，填满屏幕（可能裁剪）" },
  { label: "适应", value: "fit", desc: "适应 - 保持宽高比，完整显示（可能有黑边）" },
  { label: "拉伸", value: "stretch", desc: "拉伸 - 拉伸填满屏幕（可能变形）" },
  { label: "居中", value: "center", desc: "居中 - 原始大小居中显示" },
  { label: "平铺", value: "tile", desc: "平铺 - 重复平铺显示" },
];

const options = computed(() => {
  const list = mode.value === "window" && IS_WINDOWS
    ? styleOptions
    : styleOptions.filter((o) => nativeWallpaperStyles.value.includes(o.value as Style));
  return [SYSTEM_OPT, ...list];
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