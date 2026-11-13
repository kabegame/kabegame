<template>
  <div class="kb-control h-8 overflow-hidden" :data-disabled="disabled || undefined">
    <button
      type="button"
      class="grid h-full w-8 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent border-r border-r-solid border-r-kb-line"
      :disabled="disabled || modelValue <= min"
      :aria-label="t('common.decrease')"
      @click="step(-1)"
    >
      <Minus class="size-3.5" />
    </button>
    <span class="min-w-11 flex-1 text-center tabular-nums">{{ displayValue }}</span>
    <button
      type="button"
      class="grid h-full w-8 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent border-l border-l-solid border-l-kb-line"
      :disabled="disabled || modelValue >= max"
      :aria-label="t('common.increase')"
      @click="step(1)"
    >
      <Plus class="size-3.5" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Minus, Plus } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";

const props = withDefaults(
  defineProps<{
    modelValue: number;
    min: number;
    max: number;
    stepSize: number;
    disabled?: boolean;
    /** 展示的小数位数，默认 0（整数） */
    precision?: number;
  }>(),
  {
    disabled: false,
    precision: 0,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
}>();

const { t } = useI18n();

const displayValue = computed(() =>
  props.precision > 0 ? props.modelValue.toFixed(props.precision) : String(Math.round(props.modelValue)),
);

function step(direction: 1 | -1) {
  if (props.disabled) return;
  const next = Math.min(props.max, Math.max(props.min, props.modelValue + direction * props.stepSize));
  if (next === props.modelValue) return;
  emit("update:modelValue", Number(next.toFixed(6)));
}
</script>
