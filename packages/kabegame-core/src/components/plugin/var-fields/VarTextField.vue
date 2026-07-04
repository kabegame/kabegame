<template>
  <el-input
    :model-value="valueForInput"
    :placeholder="placeholder"
    :clearable="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

defineEmits<{
  "update:modelValue": [value: string];
}>();

const valueForInput = computed(() => {
  return typeof props.modelValue === "string" ? props.modelValue : "";
});
</script>
