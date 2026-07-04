<template>
  <el-switch :model-value="switchOn" @update:model-value="onSwitch" />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  modelValue: unknown;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();

const switchOn = computed(() => props.modelValue === true);

function onSwitch(val: boolean) {
  emit("update:modelValue", val);
}
</script>
