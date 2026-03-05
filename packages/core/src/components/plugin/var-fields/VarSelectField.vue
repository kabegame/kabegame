<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="valueForSelect ?? null"
    :options="normalizedOptions"
    :title="placeholder || '请选择'"
    :placeholder="placeholder"
    :clearable="allowUnset"
    @update:model-value="$emit('update:modelValue', $event ?? undefined)"
  />
  <el-select
    v-else
    :model-value="valueForSelect"
    :placeholder="placeholder"
    :clearable="allowUnset"
    style="width: 100%"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-option v-for="opt in normalizedOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { IS_ANDROID } from "../../../env";
import AndroidPickerSelect from "../../AndroidPickerSelect.vue";

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
  "update:modelValue": [value: string | undefined];
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

const valueForSelect = computed<string | undefined>(() => {
  return typeof props.modelValue === "string" ? props.modelValue : undefined;
});
</script>
