<template>
  <div
    role="radiogroup"
    class="inline-flex max-w-full items-center gap-0.5 rounded-kb-md bg-kb-fill p-0.5"
    :class="disabled ? 'pointer-events-none opacity-50' : ''"
  >
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      role="radio"
      :aria-checked="option.value === model"
      :disabled="disabled || option.disabled"
      class="box-border inline-flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border-0 px-2.5 py-0 [font-family:inherit] font-500 leading-none outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0"
      :class="[
        size === 'sm' ? 'h-6 text-[12px]' : 'h-7 text-[12.5px]',
        option.value === model
          ? 'bg-kb-surface-raised text-kb-fg shadow-kb-sm'
          : 'bg-transparent text-kb-fg-muted hover:text-kb-fg',
      ]"
      @click="model = option.value"
    >
      <slot name="option" :option="option">{{ option.label }}</slot>
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string | number | boolean">
/**
 * 分段控件（v-model 选中的值）：二三项互斥切换（去重保留新 / 旧、视图切换）。
 * 值可以是布尔；选项多了用 Select，要同时看到说明时用 RadioGroup。
 */
withDefaults(
  defineProps<{
    options: { label: string; value: T; disabled?: boolean }[];
    disabled?: boolean;
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

const model = defineModel<T>();
</script>
