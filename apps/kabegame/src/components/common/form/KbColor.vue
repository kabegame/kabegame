<template>
  <el-color-picker :model-value="hex" :show-alpha="false" @change="onChange" />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ modelValue: unknown }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const hex = computed(() => (typeof props.modelValue === "string" ? props.modelValue : null));
function onChange(value: string | null) {
  if (value) emit("update:modelValue", value);
}
</script>
