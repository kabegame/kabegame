<template>
  <div
    class="flex h-9 w-full min-w-0 items-stretch overflow-hidden rounded-xl border border-solid border-[var(--anime-border)] bg-[var(--anime-bg-card)] transition-colors"
  >
    <button
      type="button"
      class="flex h-full w-9 flex-none cursor-pointer items-center justify-center border-0 border-r border-r-solid border-r-[var(--anime-border)] bg-transparent p-0 text-[var(--anime-secondary)] text-base leading-none hover:text-[var(--anime-primary)] disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="decreaseDisabled"
      :aria-label="t('common.decrease')"
      @click="step(-1)"
    >
      −
    </button>
    <input
      class="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-center text-[var(--anime-text-primary)] text-sm tabular-nums outline-none"
      type="text"
      inputmode="numeric"
      :value="inputText"
      :placeholder="placeholder"
      :title="placeholder"
      @input="onInput"
    />
    <button
      type="button"
      class="flex h-full w-9 flex-none cursor-pointer items-center justify-center border-0 border-l border-l-solid border-l-[var(--anime-border)] bg-transparent p-0 text-[var(--anime-secondary)] text-base leading-none hover:text-[var(--anime-primary)] disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="increaseDisabled"
      :aria-label="t('common.increase')"
      @click="step(1)"
    >
      +
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useFormItem } from "@kabegame/element-plus";
import { useI18n } from "@kabegame/i18n";

const props = defineProps<{
  modelValue: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number | string];
}>();

const { t } = useI18n();
const { formItem } = useFormItem();
const inputText = ref(formatValue(props.modelValue));

const numberValue = computed(() =>
  typeof props.modelValue === "number" && Number.isFinite(props.modelValue) && Number.isInteger(props.modelValue)
    ? props.modelValue
    : undefined,
);
const hasMin = computed(() => typeof props.min === "number" && Number.isFinite(props.min));
const hasMax = computed(() => typeof props.max === "number" && Number.isFinite(props.max));
const decreaseDisabled = computed(
  () => numberValue.value === undefined || (hasMin.value && numberValue.value <= (props.min as number)),
);
const increaseDisabled = computed(
  () => numberValue.value === undefined || (hasMax.value && numberValue.value >= (props.max as number)),
);

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function parseInput(text: string): number | string {
  if (!/^[+-]?\d+$/.test(text)) return text;
  const parsed = Number(text);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : text;
}

function onInput(event: Event) {
  const text = (event.target as HTMLInputElement).value;
  inputText.value = text;
  emit("update:modelValue", parseInput(text));
}

function step(direction: 1 | -1) {
  const current = numberValue.value;
  if (current === undefined) return;
  const next = current + direction;
  if (hasMin.value && next < (props.min as number)) return;
  if (hasMax.value && next > (props.max as number)) return;
  inputText.value = String(next);
  emit("update:modelValue", next);
}

watch(
  () => [props.modelValue, props.min, props.max] as const,
  async ([value], [previousValue]) => {
    if (!Object.is(value, previousValue)) inputText.value = formatValue(value);
    await nextTick();
    await formItem?.validate("change").catch(() => undefined);
  },
);
</script>
