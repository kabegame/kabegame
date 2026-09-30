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
    :title="selectedLabel || placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <!-- 下拉宽度已统一为输入框宽度，长文案会被 ellipsis 截断；补原生 title 让鼠标能看全 -->
    <el-option
      v-for="opt in normalizedOptions"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
      :title="opt.label"
    />
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
  { allowUnset: false },
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

/** 触发器里显示的选项文案（窄栅格里会被截断，靠 title 看全） */
const selectedLabel = computed(
  () => normalizedOptions.value.find((o) => o.value === valueForSelect.value)?.label ?? "",
);
</script>
