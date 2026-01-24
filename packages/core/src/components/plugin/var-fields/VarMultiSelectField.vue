<template>
  <el-select :model-value="valueForSelect" multiple :placeholder="placeholder" :clearable="allowUnset" collapse-tags
    collapse-tags-tooltip style="width: 100%" @update:model-value="$emit('update:modelValue', $event)">
    <el-option v-for="opt in normalizedOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";

type VarOption = string | { name: string; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      return { label: o.name, value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "");
});

const valueForSelect = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`) : [];
});
</script>
