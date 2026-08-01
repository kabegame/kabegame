<template>
  <AndroidPickerNumber
    v-if="isCompact"
    :model-value="numberValue"
    :min="effectiveMin"
    :max="effectiveMax"
    :step="1"
    :title="placeholder || '请选择'"
    :placeholder="placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  />
  <!-- 上下限都给了：滑杆直观展示范围内的位置，右侧数字框可直接输入 -->
  <div v-else-if="hasFiniteMin && hasFiniteMax" class="kb-number">
    <div class="kb-number__slider-col">
      <el-slider
        class="kb-number__slider"
        :model-value="numberValue ?? effectiveMin"
        :min="effectiveMin"
        :max="effectiveMax"
        :step="sliderStep"
        :show-tooltip="false"
        @input="(v) => emitNumber(Array.isArray(v) ? v[0] : v)"
      />
      <!-- 两端刻度：让用户不用拖到底也知道可选范围 -->
      <div class="kb-number__bounds">
        <span>{{ formatNumber(effectiveMin) }}</span>
        <span>{{ formatNumber(effectiveMax) }}</span>
      </div>
    </div>
    <el-input
      class="kb-number__input"
      :model-value="inputText"
      @update:model-value="onInputText"
      @blur="onInputCommit"
      @keyup.enter="onInputCommit"
    />
  </div>
  <!-- 缺上限或下限：没法画一条有尽头的滑杆，用步进器 -->
  <KbStepper
    v-else
    :model-value="numberValue ?? effectiveMin"
    :min="hasFiniteMin ? (min as number) : -Infinity"
    :max="hasFiniteMax ? (max as number) : Infinity"
    :step-size="sliderStep"
    :precision="type === 'float' ? 2 : 0"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useUiStore } from "../../../stores/ui";
import AndroidPickerNumber from "../../AndroidPickerNumber.vue";
import KbStepper from "./KbStepper.vue";

const isCompact = computed(() => useUiStore().isCompact);

const props = defineProps<{
  modelValue: unknown;
  type?: string;
  min?: number;
  max?: number;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number | undefined];
}>();

const numberValue = computed<number | undefined>(() => {
  if (typeof props.modelValue === "number" && !Number.isNaN(props.modelValue)) return props.modelValue;
  return undefined;
});

const hasFiniteMin = computed(() => typeof props.min === "number" && Number.isFinite(props.min));
const hasFiniteMax = computed(() => typeof props.max === "number" && Number.isFinite(props.max));

// AndroidPickerNumber 需要一对确定的上下限，缺失时退回 0~100（与原实现一致）
const effectiveMin = computed(() => (hasFiniteMin.value ? (props.min as number) : 0));
const effectiveMax = computed(() => (hasFiniteMax.value ? (props.max as number) : 100));

const isFloat = computed(() => props.type === "float");

/** 滑杆/步进器的步进粒度：int 恒为 1；float 按有效范围的 ~1% 取，且不小于 0.01 */
const sliderStep = computed(() => {
  if (!isFloat.value) return 1;
  const span = effectiveMax.value - effectiveMin.value;
  return span > 0 ? Math.max(span / 100, 0.01) : 0.01;
});

function formatNumber(v: number): string {
  return isFloat.value ? v.toFixed(2) : String(Math.round(v));
}

function clamp(v: number): number {
  return Math.min(effectiveMax.value, Math.max(effectiveMin.value, v));
}

function emitNumber(v: number) {
  emit("update:modelValue", isFloat.value ? Number(clamp(v).toFixed(6)) : Math.round(clamp(v)));
}

/**
 * 输入框是「半受控」的：编辑期间保留用户原始字符串（否则输入 "1." 或删空会被立刻改写），
 * 只在 blur / 回车时才归一化并提交。
 */
const inputText = ref("");
watch(
  () => [numberValue.value, effectiveMin.value, isFloat.value] as const,
  () => {
    inputText.value = formatNumber(numberValue.value ?? effectiveMin.value);
  },
  { immediate: true }
);

function onInputText(text: string) {
  inputText.value = text;
}

/** 提交：非法输入回退到当前值，合法输入 clamp 进范围 */
function onInputCommit() {
  const parsed = Number(inputText.value);
  if (inputText.value.trim() === "" || Number.isNaN(parsed)) {
    inputText.value = formatNumber(numberValue.value ?? effectiveMin.value);
    return;
  }
  emitNumber(parsed);
  inputText.value = formatNumber(clamp(parsed));
}
</script>

<style scoped>
.kb-number {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.kb-number__slider-col {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 60px;
}

.kb-number__slider :deep(.el-slider__runway) {
  background: color-mix(in srgb, var(--anime-primary) 18%, transparent);
}
.kb-number__slider :deep(.el-slider__bar) {
  background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
}
.kb-number__slider :deep(.el-slider__button) {
  border-color: var(--anime-primary);
}

.kb-number__bounds {
  display: flex;
  justify-content: space-between;
  margin-top: -4px;
  color: var(--anime-text-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.kb-number__input {
  flex: none;
  width: 76px;
}
.kb-number__input :deep(.el-input__inner) {
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
