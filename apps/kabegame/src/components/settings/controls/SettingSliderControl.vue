<template>
  <KbStepper
    v-if="isCompact"
    :model-value="localValue"
    :min="effectiveMin"
    :max="effectiveMax"
    :step-size="effectiveStep"
    :precision="precision"
    :disabled="props.disabled || disabled"
    @update:model-value="onChange"
  />
  <!-- 拖动中只改本地值（右侧数值跟手），松手（commit）才保存 -->
  <div v-else class="flex w-[min(280px,100%)] min-w-0 items-center gap-3">
    <Slider
      v-model="localValue"
      class="min-w-[80px] flex-1"
      :min="effectiveMin"
      :max="effectiveMax"
      :step="effectiveStep"
      :disabled="props.disabled || disabled"
      @commit="onChange"
    />
    <span class="min-w-[2.5em] shrink-0 text-[12px] tabular-nums text-kb-fg-muted">{{ displayValue }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";
import KbStepper from "../../common/form/KbStepper.vue";
import Slider from "@/components/ui/Slider.vue";

const props = defineProps<{
  settingKey: AppSettingKey;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** 右侧显示的小数位数，默认 2 */
  precision?: number;
}>();

const isCompact = computed(() => useUiStore().isCompact);
const { settingValue, disabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<number>(0);

const effectiveMin = computed(() => (typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0));
const effectiveMax = computed(() => (typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100));
const effectiveStep = computed(() => (typeof props.step === "number" && props.step > 0 ? props.step : 1));
const precision = computed(() => (typeof props.precision === "number" && props.precision >= 0 ? props.precision : 2));

const displayValue = computed(() => {
  const v = localValue.value;
  const p = precision.value;
  return Number.isFinite(v) ? (p > 0 ? v.toFixed(p) : String(Math.round(v))) : "0";
});

watch(
  () => settingValue.value,
  (v) => {
    const n = typeof v === "number" ? v : Number(v);
    localValue.value = Number.isFinite(n) ? n : 0;
  },
  { immediate: true },
);

const onChange = async (v: number | undefined) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const ok = await set(v);
  if (!ok) {
    const current = Number(settingValue.value);
    localValue.value = Number.isFinite(current) ? current : 0;
  }
};
</script>
