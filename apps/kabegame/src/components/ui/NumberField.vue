<template>
  <NumberFieldRoot
    v-model="model"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :format-options="formatOptions ?? { useGrouping: false }"
    :class="['kb-control', size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8']"
    :data-invalid="field.invalid.value || undefined"
  >
    <NumberFieldDecrement
      class="grid h-full w-7 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-kb-fg-muted hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Minus class="size-3.5" />
    </NumberFieldDecrement>
    <NumberFieldInput
      :id="field.id.value"
      :placeholder="placeholder"
      :aria-invalid="field.invalid.value || undefined"
      :aria-describedby="field.describedBy.value"
      class="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-center tabular-nums text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle"
    />
    <span v-if="unit" class="shrink-0 text-[12px] text-kb-fg-subtle">{{ unit }}</span>
    <NumberFieldIncrement
      class="grid h-full w-7 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-kb-fg-muted hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Plus class="size-3.5" />
    </NumberFieldIncrement>
  </NumberFieldRoot>
</template>

<script setup lang="ts">
/**
 * 数字输入（v-model number；清空时是 undefined）。两侧 −/+，上下方向键与滚轮步进，失焦时按 min / max 收拢。
 * 默认不加千位分隔符（formatOptions 可改）。
 */
import { NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput, NumberFieldRoot } from "reka-ui";
import { Minus, Plus } from "@lucide/vue";
import { useFieldControl } from "./field";

const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    placeholder?: string;
    /** 数字后面的单位（秒、张） */
    unit?: string;
    formatOptions?: Intl.NumberFormatOptions;
    invalid?: boolean;
    id?: string;
    size?: "sm" | "md";
  }>(),
  { step: 1, size: "md" },
);

const model = defineModel<number | undefined>();
const field = useFieldControl(props);
</script>
