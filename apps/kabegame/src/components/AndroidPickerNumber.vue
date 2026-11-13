<template>
  <button
    type="button"
    class="android-picker-number kb-control h-8 cursor-pointer justify-between gap-2 px-2.5 text-left [font:inherit]"
    :data-disabled="disabled || undefined"
    :aria-disabled="disabled || undefined"
    @click="onTriggerClick"
  >
    <span class="min-w-0 flex-1 truncate" :class="numberValue === undefined ? 'text-kb-fg-subtle' : ''">
      {{ numberValue !== undefined ? numberValue : resolvedPlaceholder }}
    </span>
    <ChevronDown class="size-4 shrink-0 text-kb-fg-subtle" />
  </button>

  <PickerSheet
    v-model:open="isOpen"
    v-model="pickerSelectedValues"
    :title="resolvedTitle"
    :columns="pickerColumns"
    @confirm="onPickerConfirm"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ChevronDown } from "@lucide/vue";
import PickerSheet from "@/components/ui/PickerSheet.vue";

const props = withDefaults(
  defineProps<{
    modelValue: number | undefined;
    min?: number;
    max?: number;
    step?: number;
    title?: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { min: 0, max: 100, step: 1, title: undefined, placeholder: undefined, disabled: false },
);

const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));
const resolvedPlaceholder = computed(() => props.placeholder ?? t("common.selectPlaceholder"));

const emit = defineEmits<{
  "update:modelValue": [value: number | undefined];
}>();

const isOpen = ref(false);

const numberValue = computed(() => {
  const v = props.modelValue;
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  return v;
});

const pickerColumns = computed(() => {
  const min = typeof props.min === "number" && !Number.isNaN(props.min) ? props.min : 0;
  const max = typeof props.max === "number" && !Number.isNaN(props.max) ? props.max : 100;
  const step = typeof props.step === "number" && props.step > 0 ? props.step : 1;
  const options: { text: string; value: number }[] = [];
  for (let n = min; n <= max; n += step) {
    options.push({ text: String(n), value: n });
  }
  return options;
});

const pickerSelectedValues = ref<number[]>([]);

watch(isOpen, (v) => {
  if (v) {
    const v = props.modelValue;
    const num = typeof v === "number" && !Number.isNaN(v) ? v : (props.min ?? 0);
    const clamped = Math.max(props.min ?? 0, Math.min(props.max ?? 100, num));
    const step = props.step ?? 1;
    const aligned = Math.round((clamped - (props.min ?? 0)) / step) * step + (props.min ?? 0);
    const final = Math.max(props.min ?? 0, Math.min(props.max ?? 100, aligned));
    pickerSelectedValues.value = [final];
  }
});

watch(
  () => [props.modelValue, props.min, props.max, props.step] as const,
  () => {
    if (isOpen.value) {
      const v = props.modelValue;
      const num = typeof v === "number" && !Number.isNaN(v) ? v : (props.min ?? 0);
      const clamped = Math.max(props.min ?? 0, Math.min(props.max ?? 100, num));
      const step = props.step ?? 1;
      const aligned = Math.round((clamped - (props.min ?? 0)) / step) * step + (props.min ?? 0);
      const final = Math.max(props.min ?? 0, Math.min(props.max ?? 100, aligned));
      pickerSelectedValues.value = [final];
    }
  },
);

function onTriggerClick() {
  if (props.disabled) return;
  isOpen.value = true;
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
  const raw = selectedValues[0];
  if (raw === undefined || raw === null) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  emit("update:modelValue", value);
}
</script>
