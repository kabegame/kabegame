<template>
  <CheckboxGroupRoot
    v-model="model"
    :disabled="disabled"
    class="flex gap-x-5 gap-y-2"
    :class="orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap'"
  >
    <slot>
      <Checkbox
        v-for="item in items"
        :key="String(item.value)"
        :value="item.value"
        :disabled="item.disabled"
        :label="item.label"
      />
    </slot>
  </CheckboxGroupRoot>
</template>

<script setup lang="ts" generic="T extends string | number">
/** 一组复选框（v-model 数组）：items 给选项，或在默认插槽里放 <Checkbox :value>。 */
import { CheckboxGroupRoot } from "reka-ui";
import Checkbox from "./Checkbox.vue";

withDefaults(
  defineProps<{
    items?: { label: string; value: T; disabled?: boolean }[];
    disabled?: boolean;
    orientation?: "horizontal" | "vertical";
  }>(),
  { items: () => [], orientation: "horizontal" },
);

const model = defineModel<T[]>({ default: () => [] });
</script>
