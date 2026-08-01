<template>
  <KbNumber
    v-if="type === 'int' || type === 'float'"
    :type="type"
    :model-value="modelValue"
    :min="min"
    :max="max"
    :placeholder="placeholder"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbSelect
    v-else-if="type === 'options'"
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbBoolean
    v-else-if="type === 'boolean'"
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbMultiSelect
    v-else-if="type === 'list'"
    :model-value="modelValue"
    :options="options"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbCheckboxGroup
    v-else-if="type === 'checkbox'"
    :model-value="modelValue"
    :options="options"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbPath
    v-else-if="type === 'path' || type === 'file_or_folder' || type === 'file' || type === 'folder'"
    :type="type"
    :model-value="modelValue"
    :file-extensions="fileExtensions"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbText
    v-else-if="type === 'string'"
    :model-value="modelValue"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbDate
    v-else-if="type === 'date'"
    :model-value="modelValue"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    :date-storage-format="dateFormat"
    :date-min="dateMin"
    :date-max="dateMax"
    @update:model-value="$emit('update:modelValue', $event)"
  />

  <KbText
    v-else
    :model-value="modelValue"
    :placeholder="placeholder"
    :allow-unset="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup lang="ts">
import KbBoolean from "../../common/form/KbBoolean.vue";
import KbCheckboxGroup from "../../common/form/KbCheckboxGroup.vue";
import KbDate from "../../common/form/KbDate.vue";
import KbMultiSelect from "../../common/form/KbMultiSelect.vue";
import KbNumber from "../../common/form/KbNumber.vue";
import KbPath from "../../common/form/KbPath.vue";
import KbSelect from "../../common/form/KbSelect.vue";
import KbText from "../../common/form/KbText.vue";

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
  /** date 类型：dayjs 格式，写入 vars 的字符串形态 */
  dateFormat?: string;
  /** date 类型：可选最早/最晚日（YYYY-MM-DD） */
  dateMin?: string;
  dateMax?: string;
}>();

defineEmits<{
  "update:modelValue": [value: unknown];
}>();
</script>
