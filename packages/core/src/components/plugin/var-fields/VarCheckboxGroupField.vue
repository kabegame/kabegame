<template>
  <el-checkbox-group
    :model-value="valueForGroup"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-checkbox v-for="opt in normalizedOptions" :key="opt.value" :label="opt.value">
      {{ opt.label }}
    </el-checkbox>
  </el-checkbox-group>
</template>

<script setup lang="ts">
import { computed } from "vue";

type VarOption = string | { name: string; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
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

const valueForGroup = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`) : [];
});
</script>
