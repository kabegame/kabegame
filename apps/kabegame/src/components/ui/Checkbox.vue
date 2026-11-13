<template>
  <label
    class="inline-flex cursor-pointer select-none items-start gap-2 text-[13px] leading-5 text-kb-fg"
    :class="disabled ? 'cursor-not-allowed opacity-50' : ''"
  >
    <CheckboxRoot
      v-model="model"
      :value="value"
      :disabled="disabled"
      :id="field.id.value"
      :aria-invalid="field.invalid.value || undefined"
      class="peer mt-0.5 box-border grid size-4 shrink-0 cursor-pointer place-items-center rounded-[4px] border border-solid border-kb-line-strong bg-kb-surface-raised p-0 text-kb-primary-fg outline-none transition-colors duration-100 hover:border-kb-fg-subtle focus-visible:ring-2 focus-visible:ring-kb-ring data-[state=checked]:border-kb-primary data-[state=checked]:bg-kb-primary data-[state=indeterminate]:border-kb-primary data-[state=indeterminate]:bg-kb-primary disabled:cursor-not-allowed"
    >
      <CheckboxIndicator class="grid place-items-center">
        <Minus v-if="model === 'indeterminate'" class="size-3" :stroke-width="3" />
        <Check v-else class="size-3" :stroke-width="3" />
      </CheckboxIndicator>
    </CheckboxRoot>
    <span v-if="label || $slots.default" class="min-w-0">
      <slot>{{ label }}</slot>
    </span>
  </label>
</template>

<script setup lang="ts">
/**
 * 复选框（v-model 布尔或 "indeterminate"）。放在 CheckboxGroup 里时给 value、不用 v-model。
 * 文字用 label 或默认插槽，点文字也能勾。
 */
import { CheckboxIndicator, CheckboxRoot, type AcceptableValue } from "reka-ui";
import { Check, Minus } from "@lucide/vue";
import { useFieldControl } from "./field";

const props = defineProps<{
  label?: string;
  disabled?: boolean;
  /** 在 CheckboxGroup 里代表的值 */
  value?: AcceptableValue;
  invalid?: boolean;
  id?: string;
}>();

const model = defineModel<boolean | "indeterminate">();
const field = useFieldControl(props);
</script>
