<template>
  <VarNumberField
    v-if="type === 'int' || type === 'float'"
    :model-value="modelValue"
    :min="min"
    :max="max"
    :placeholder="placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarSelectField
    v-else-if="type === 'options'"
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarBooleanField
    v-else-if="type === 'boolean'"
    :model-value="modelValue"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarMultiSelectField
    v-else-if="type === 'list'"
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarCheckboxGroupField
    v-else-if="type === 'checkbox'"
    :model-value="modelValue"
    :options="options"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarPathField
    v-else-if="type === 'path' || type === 'file_or_folder' || type === 'file' || type === 'folder'"
    :type="type"
    :model-value="modelValue"
    :file-extensions="fileExtensions"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <VarTextField
    v-else
    :model-value="modelValue"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import VarBooleanField from "./VarBooleanField.vue";
import VarCheckboxGroupField from "./VarCheckboxGroupField.vue";
import VarMultiSelectField from "./VarMultiSelectField.vue";
import VarNumberField from "./VarNumberField.vue";
import VarPathField from "./VarPathField.vue";
import VarSelectField from "./VarSelectField.vue";
import VarTextField from "./VarTextField.vue";

export type VarOption = string | { name: string; variable: string };

defineProps<{
  type: string;
  modelValue: unknown;
  options?: VarOption[];
  min?: number;
  max?: number;
  placeholder?: string;
  fileExtensions?: string[];
  allowUnset?: boolean;
}>();

defineEmits<{
  "update:modelValue": [value: unknown];
}>();
</script>
