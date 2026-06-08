<template>
  <input
    class="preview-range-slider"
    :class="{ vertical }"
    type="range"
    :min="min"
    :max="max"
    :step="step"
    :value="modelValue"
    :aria-label="ariaLabel"
    @input="handleInput"
    @change="handleChange"
    @mousedown.stop="$emit('drag-start')"
    @touchstart.stop="$emit('drag-start')"
    @click.stop
  />
</template>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    ariaLabel?: string;
    vertical?: boolean;
  }>(),
  {
    min: 0,
    max: 100,
    step: 0.1,
    ariaLabel: undefined,
    vertical: false,
  }
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
  (e: "change", value: number): void;
  (e: "drag-start"): void;
}>();

const readRangeValue = (event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  return Number.isFinite(value) ? value : props.min;
};

const handleInput = (event: Event) => {
  emit("update:modelValue", readRangeValue(event));
};

const handleChange = (event: Event) => {
  emit("change", readRangeValue(event));
};
</script>

<style scoped lang="scss">
.preview-range-slider {
  width: 100%;
  margin: 0;
  cursor: pointer;
  accent-color: #ff5fb8;

  &.vertical {
    width: 104px;
    transform: rotate(-90deg);
    transform-origin: center;
  }
}
</style>
