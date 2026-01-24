<template>
  <el-input-number
    :model-value="numberValue"
    :min="typeof min === 'number' && !isNaN(min) ? min : undefined"
    :max="typeof max === 'number' && !isNaN(max) ? max : undefined"
    :placeholder="placeholder"
    style="width: 100%"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modelValue: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
}>();

defineEmits<{
  "update:modelValue": [value: number | undefined];
}>();

const numberValue = computed<number | undefined>(() => {
  if (typeof props.modelValue === "number" && !Number.isNaN(props.modelValue)) return props.modelValue;
  return undefined;
});
</script>
