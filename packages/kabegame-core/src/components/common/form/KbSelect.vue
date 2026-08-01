<template>
  <AndroidPickerSelect
    v-if="isCompact"
    :model-value="valueForSelect ?? null"
    :options="normalizedOptions"
    :title="placeholder || '请选择'"
    :placeholder="placeholder"
    :clearable="allowUnset"
    @update:model-value="$emit('update:modelValue', $event ?? undefined)"
  />
  <!-- 选项少时用分段器：一眼看全部选项，省一次点击展开 -->
  <KbSegmentedControl
    v-else-if="normalizedOptions.length > 0 && normalizedOptions.length <= 4"
    :model-value="valueForSelect ?? ''"
    :options="normalizedOptions"
    @update:model-value="$emit('update:modelValue', $event)"
  />
  <el-select
    v-else
    :model-value="valueForSelect"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :filterable="normalizedOptions.length >= 9"
    style="width: 100%"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-option v-for="opt in normalizedOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useUiStore } from "../../../stores/ui";
import AndroidPickerSelect from "../../AndroidPickerSelect.vue";
import KbSegmentedControl from "./KbSegmentedControl.vue";

const isCompact = computed(() => useUiStore().isCompact);

type VarOption = string | { name: string | Record<string, string>; variable: string };

function optionLabel(o: VarOption): string {
  if (typeof o === "string") return o;
  if (typeof o.name === "string") return o.name;
  if (o.name && typeof o.name === "object") return (o.name as Record<string, string>).default ?? "";
  return "";
}

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
      return { label: optionLabel(o), value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "");
});

const valueForSelect = computed<string | undefined>(() => {
  return typeof props.modelValue === "string" ? props.modelValue : undefined;
});
</script>
