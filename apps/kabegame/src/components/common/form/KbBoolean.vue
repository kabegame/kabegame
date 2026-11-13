<template>
  <Switch :model-value="modelValue === true" @update:model-value="(v) => emit('update:modelValue', v === true)" />
</template>

<script setup lang="ts">
import Switch from "@/components/ui/Switch.vue";

defineProps<{
  modelValue: unknown;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();
</script>
