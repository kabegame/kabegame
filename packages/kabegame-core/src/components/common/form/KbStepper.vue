<template>
  <div class="setting-stepper" :class="{ 'is-disabled': disabled }">
    <button
      type="button"
      class="setting-stepper-btn"
      :disabled="disabled || modelValue <= min"
      :aria-label="t('common.decrease')"
      @click="step(-1)"
    >
      −
    </button>
    <span class="setting-stepper-value">{{ displayValue }}</span>
    <button
      type="button"
      class="setting-stepper-btn"
      :disabled="disabled || modelValue >= max"
      :aria-label="t('common.increase')"
      @click="step(1)"
    >
      +
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";

const props = withDefaults(defineProps<{
  modelValue: number;
  min: number;
  max: number;
  stepSize: number;
  disabled?: boolean;
  /** 展示的小数位数，默认 0（整数） */
  precision?: number;
}>(), {
  disabled: false,
  precision: 0,
});

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();

const { t } = useI18n();

const displayValue = computed(() =>
  props.precision > 0 ? props.modelValue.toFixed(props.precision) : String(Math.round(props.modelValue))
);

function step(direction: 1 | -1) {
  if (props.disabled) return;
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + direction * props.stepSize));
  if (next === props.modelValue) return;
  emit("update:modelValue", Number(next.toFixed(6)));
}
</script>

<style scoped>
.setting-stepper {
  display: flex;
  align-items: center;
  height: 34px;
  overflow: hidden;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  background: var(--anime-bg-card);
}

.setting-stepper.is-disabled {
  opacity: 0.6;
}

.setting-stepper-btn {
  appearance: none;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 100%;
  padding: 0;
  border: none;
  margin: 0;
  color: var(--anime-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 15px;
  line-height: 1;
}

.setting-stepper-btn:first-child {
  border-right: 1px solid color-mix(in srgb, var(--anime-primary) 18%, transparent);
}

.setting-stepper-btn:last-child {
  border-left: 1px solid color-mix(in srgb, var(--anime-primary) 18%, transparent);
}

.setting-stepper-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.setting-stepper-btn:not(:disabled):hover {
  color: var(--anime-primary);
}

.setting-stepper-value {
  flex: 1;
  min-width: 44px;
  text-align: center;
  color: var(--anime-text-primary);
  font-size: 13.5px;
  font-variant-numeric: tabular-nums;
}
</style>
