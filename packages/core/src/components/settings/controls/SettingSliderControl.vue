<template>
  <AndroidPickerNumber
    v-if="isCompact"
    :model-value="localValue"
    :min="effectiveMin"
    :max="effectiveMax"
    :step="effectiveStep"
    title="选择数值"
    :disabled="props.disabled || disabled"
    @update:model-value="onChange"
  />
  <div v-else class="setting-slider-wrap">
    <el-slider
      v-model="localValue"
      :min="effectiveMin"
      :max="effectiveMax"
      :step="effectiveStep"
      :disabled="props.disabled || disabled"
      :show-tooltip="true"
      :format-tooltip="formatTooltip"
      @change="onChange"
    />
    <span class="setting-slider-value">{{ displayValue }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import AndroidPickerNumber from "../../AndroidPickerNumber.vue";

const props = defineProps<{
  settingKey: AppSettingKey;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** 滑块提示与右侧显示的小数位数，默认 2 */
  precision?: number;
}>();

const isCompact = computed(() => useUiStore().isCompact);
const { settingValue, disabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<number>(0);

const effectiveMin = computed(() =>
  typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0
);
const effectiveMax = computed(() =>
  typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100
);
const effectiveStep = computed(() =>
  typeof props.step === "number" && props.step > 0 ? props.step : 1
);
const precision = computed(() =>
  typeof props.precision === "number" && props.precision >= 0 ? props.precision : 2
);

const displayValue = computed(() => {
  const v = localValue.value;
  const p = precision.value;
  return Number.isFinite(v) ? (p > 0 ? v.toFixed(p) : String(Math.round(v))) : "0";
});

function formatTooltip(val: number) {
  const p = precision.value;
  return Number.isFinite(val) ? (p > 0 ? val.toFixed(p) : String(Math.round(val))) : "0";
}

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? n : 0;
  },
  { immediate: true }
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  await set(v);
};
</script>

<style scoped>
.setting-slider-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.setting-slider-wrap :deep(.el-slider) {
  flex: 1;
  min-width: 80px;
}
.setting-slider-value {
  flex-shrink: 0;
  min-width: 2.5em;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
