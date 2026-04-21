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
  <el-input-number
    v-else
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
import { useUiStore } from "../../../stores/ui";
import AndroidPickerNumber from "../../AndroidPickerNumber.vue";

const isCompact = computed(() => useUiStore().isCompact);

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

const effectiveMin = computed(() =>
  typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0
);
const effectiveMax = computed(() =>
  typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100
);
</script>
