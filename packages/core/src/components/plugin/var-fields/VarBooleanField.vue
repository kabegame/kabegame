<template>
  <el-select
    v-if="allowUnset"
    :model-value="valueForSelect"
    clearable
    placeholder="未设置"
    style="width: 100%"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-option label="true" :value="true" />
    <el-option label="false" :value="false" />
  </el-select>

  <el-switch v-else :model-value="valueForSwitch" @update:model-value="$emit('update:modelValue', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

defineEmits<{
  "update:modelValue": [value: boolean | undefined];
}>();

const valueForSelect = computed<boolean | undefined>(() => {
  return typeof props.modelValue === "boolean" ? props.modelValue : undefined;
});

const valueForSwitch = computed<boolean>(() => {
  return typeof props.modelValue === "boolean" ? props.modelValue : false;
});
</script>
