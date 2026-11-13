<template>
  <RadioGroupRoot
    v-model="model"
    :disabled="disabled"
    :orientation="orientation"
    class="flex gap-x-5 gap-y-2"
    :class="orientation === 'vertical' ? 'flex-col' : 'flex-row flex-wrap'"
  >
    <label
      v-for="item in items"
      :key="String(item.value)"
      class="inline-flex cursor-pointer select-none items-start gap-2 text-[13px] leading-5 text-kb-fg"
      :class="item.disabled || disabled ? 'cursor-not-allowed opacity-50' : ''"
    >
      <RadioGroupItem
        :value="item.value"
        :disabled="item.disabled"
        class="mt-0.5 box-border grid size-4 shrink-0 cursor-pointer place-items-center rounded-full border border-solid border-kb-line-strong bg-kb-surface-raised p-0 outline-none transition-colors duration-100 hover:border-kb-fg-subtle focus-visible:ring-2 focus-visible:ring-kb-ring data-[state=checked]:border-kb-primary data-[state=checked]:bg-kb-primary"
      >
        <RadioGroupIndicator class="block size-1.5 rounded-full bg-kb-primary-fg" />
      </RadioGroupItem>
      <span class="flex min-w-0 flex-col">
        <slot name="item" :item="item">{{ item.label }}</slot>
        <span v-if="item.description" class="text-[12px] leading-[1.5] text-kb-fg-muted">{{ item.description }}</span>
      </span>
    </label>
  </RadioGroupRoot>
</template>

<script setup lang="ts" generic="T extends string | number">
/** 单选组（v-model 选中的值）。选项少且要同时看到时用它；多了用 Select，二三项的切换用分段控件。 */
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from "reka-ui";

withDefaults(
  defineProps<{
    items: { label: string; value: T; disabled?: boolean; description?: string }[];
    disabled?: boolean;
    orientation?: "horizontal" | "vertical";
  }>(),
  { orientation: "vertical" },
);

const model = defineModel<T>();
</script>
