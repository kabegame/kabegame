<template>
  <el-date-picker
    class="var-date-field"
    :model-value="modelValueForPicker"
    type="date"
    :placeholder="placeholder"
    :clearable="allowUnset"
    value-format="YYYY-MM-DD"
    style="width: 100%"
    @update:model-value="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const modelValueForPicker = computed(() => {
  const v = props.modelValue;
  if (typeof v === "string" && v.trim() !== "") return v;
  return undefined;
});

function onUpdate(val: string | null | undefined) {
  emit("update:modelValue", val ?? "");
}
</script>
