<template>
  <div class="aspect-ratio-setting">
    <el-select v-model="localValue" placeholder="选择宽高比" style="width: 180px" clearable :disabled="disabled" :loading="showDisabled"
      @change="onChange">
      <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
    </el-select>
    <div class="hint">
      选择画廊图片的宽高比。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("galleryImageAspectRatio");

const desktopResolution = ref<{ width: number; height: number } | null>(null);

const commonAspectRatios = [
  { label: "16:9", value: "16:9", ratio: 16 / 9 },
  { label: "16:10", value: "16:10", ratio: 16 / 10 },
  { label: "21:9", value: "21:9", ratio: 21 / 9 },
  { label: "4:3", value: "4:3", ratio: 4 / 3 },
  { label: "5:4", value: "5:4", ratio: 5 / 4 },
  { label: "3:2", value: "3:2", ratio: 3 / 2 },
  { label: "32:9", value: "32:9", ratio: 32 / 9 },
];

const options = computed(() => {
  if (!desktopResolution.value) {
    return commonAspectRatios.map((ar) => ({ label: ar.label, value: ar.value }));
  }

  const desktopRatio = desktopResolution.value.width / desktopResolution.value.height;
  // 使用相对误差来匹配宽高比，更准确（允许 0.5% 的相对误差）
  const matched = commonAspectRatios.find((ar) => {
    const relativeError = Math.abs(ar.ratio - desktopRatio) / Math.max(ar.ratio, desktopRatio);
    return relativeError < 0.005; // 0.5% 相对误差
  });

  const opts = commonAspectRatios.map((ar) => {
    const relativeError = Math.abs(ar.ratio - desktopRatio) / Math.max(ar.ratio, desktopRatio);
    const isDesktopMatch = relativeError < 0.005; // 0.5% 相对误差
    return {
      label: isDesktopMatch ? `${ar.label} (您的桌面)` : ar.label,
      value: ar.value,
    };
  });

  if (!matched) {
    const customValue = `custom:${desktopResolution.value.width}:${desktopResolution.value.height}`;
    opts.push({
      label: `自定义 ${desktopResolution.value.width}:${desktopResolution.value.height} (您的桌面)`,
      value: customValue,
    });
  }

  return opts;
});

// 检查设置值是否在有效选项中
// 支持格式：标准比例（如 "16:9"）、custom:x:y、x:y
const isValidValue = (
  value: string | null,
  availableOptions: Array<{ value: string }>,
  desktopResolution: { width: number; height: number } | null
): boolean => {
  if (!value) return false;

  // 检查是否在选项列表中（包括标准比例和 custom:x:y 格式）
  if (availableOptions.some((opt) => opt.value === value)) {
    return true;
  }

  // 检查是否是 x:y 格式且匹配桌面分辨率
  if (desktopResolution) {
    const xYPattern = /^(\d+):(\d+)$/;
    const match = value.match(xYPattern);
    if (match) {
      const width = parseInt(match[1], 10);
      const height = parseInt(match[2], 10);
      // 检查是否匹配桌面分辨率
      if (width === desktopResolution.width && height === desktopResolution.height) {
        return true;
      }
    }
  }

  return false;
};

// 根据桌面分辨率生成设置值（格式：x:y，如果匹配标准比例则返回标准值如 "16:9"）
const generateDesktopValue = (width: number, height: number): string => {
  const ratio = width / height;
  // 使用相对误差来匹配宽高比，更准确（允许 0.5% 的相对误差）
  const matched = commonAspectRatios.find((ar) => {
    const relativeError = Math.abs(ar.ratio - ratio) / Math.max(ar.ratio, ratio);
    return relativeError < 0.005; // 0.5% 相对误差
  });
  return matched ? matched.value : `${width}:${height}`;
};

const localValue = ref<string | null>(null);
watch(
  () => settingValue.value,
  (v) => {
    localValue.value = (v as any as string | null) || null;
  },
  { immediate: true }
);

const onChange = async (v: any) => {
  const val = v == null ? null : String(v);
  await set(val);
};

onMounted(async () => {
  // 获取桌面分辨率
  try {
    const [width, height] = await invoke<[number, number]>("get_desktop_resolution");
    desktopResolution.value = { width, height };
  } catch (e) {
    desktopResolution.value = null;
  }

  // 获取当前设置值
  const currentValue = (settingValue.value as string | null) || null;

  // 如果桌面分辨率获取失败，无法进行自动设置
  if (!desktopResolution.value) {
    return;
  }

  // 生成可用选项列表（用于验证当前值是否有效）
  const availableOptions = options.value;

  // 检查当前设置值是否有效
  if (isValidValue(currentValue, availableOptions, desktopResolution.value)) {
    // 值存在且在列表中，直接返回
    return;
  }

  // 值为 null 或不在有效列表中，根据桌面分辨率设置新值
  const newValue = generateDesktopValue(
    desktopResolution.value.width,
    desktopResolution.value.height
  );

  try {
    await set(newValue);
  } catch {
    // ignore
  }
});
</script>

<style scoped lang="scss">
.aspect-ratio-setting {
  width: 100%;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--anime-text-muted);
}
</style>
