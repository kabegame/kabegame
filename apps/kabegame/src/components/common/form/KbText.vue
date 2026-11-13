<template>
  <Input
    ref="inputRef"
    :model-value="valueForInput"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :title="placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import Input from "@/components/ui/Input.vue";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false },
);

defineEmits<{
  "update:modelValue": [value: string];
}>();

const inputRef = ref<InstanceType<typeof Input>>();

const valueForInput = computed(() => {
  return typeof props.modelValue === "string" ? props.modelValue : "";
});

defineExpose({
  focus: () => inputRef.value?.focus(),
});
</script>
