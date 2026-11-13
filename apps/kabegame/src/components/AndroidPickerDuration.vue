<template>
  <button
    type="button"
    class="android-picker-duration kb-control h-8 cursor-pointer justify-between gap-2 px-2.5 text-left [font:inherit]"
    :data-disabled="disabled || undefined"
    :aria-disabled="disabled || undefined"
    @click="onTriggerClick"
  >
    <span class="min-w-0 flex-1 truncate" :class="displayValue === undefined ? 'text-kb-fg-subtle' : ''">
      {{ displayValue !== undefined ? displayValue : resolvedPlaceholder }}
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

const MIN_MS = 100;
const MAX_MS = 10000;
const MS_STEP = 100;

const props = withDefaults(
  defineProps<{
    modelValue: number | undefined;
    title?: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { title: undefined, placeholder: undefined, disabled: false },
);

const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("common.selectPlaceholder"));
const resolvedPlaceholder = computed(() => props.placeholder ?? t("common.selectPlaceholder"));

const emit = defineEmits<{
  "update:modelValue": [value: number | undefined];
}>();

const isOpen = ref(false);

function msToSecAndMs(totalMs: number): [number, number] {
  const clamped = Math.max(MIN_MS, Math.min(MAX_MS, totalMs));
  const sec = Math.floor(clamped / 1000);
  const ms = Math.round((clamped % 1000) / MS_STEP) * MS_STEP;
  return [sec, ms];
}

function secAndMsToMs(sec: number, ms: number): number {
  const total = sec * 1000 + ms;
  return Math.max(MIN_MS, Math.min(MAX_MS, total));
}

const displayValue = computed(() => {
  const v = props.modelValue;
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  const clamped = Math.max(MIN_MS, Math.min(MAX_MS, v));
  if (clamped >= 1000) {
    const sec = Math.floor(clamped / 1000);
    const ms = clamped % 1000;
    return ms > 0 ? t("common.durationFormatSecMs", { sec, ms }) : t("common.durationFormatSec", { sec });
  }
  return t("common.durationFormatMs", { ms: clamped });
});

const pickerColumns = computed(() => {
  const secCol: { text: string; value: number }[] = [];
  for (let s = 0; s <= 10; s++) {
    secCol.push({ text: t("common.pickerColumnSeconds", { n: s }), value: s });
  }
  const msCol: { text: string; value: number }[] = [];
  for (let m = 0; m <= 900; m += MS_STEP) {
    msCol.push({ text: t("common.pickerColumnMilliseconds", { n: m }), value: m });
  }
  return [secCol, msCol];
});

const pickerSelectedValues = ref<number[]>([0, 500]);

watch(isOpen, (open) => {
  if (open) {
    const v = props.modelValue;
    const num = typeof v === "number" && !Number.isNaN(v) ? v : 500;
    const [sec, ms] = msToSecAndMs(num);
    pickerSelectedValues.value = [sec, ms];
  }
});

watch(
  () => props.modelValue,
  () => {
    if (isOpen.value) {
      const v = props.modelValue;
      const num = typeof v === "number" && !Number.isNaN(v) ? v : 500;
      const [sec, ms] = msToSecAndMs(num);
      pickerSelectedValues.value = [sec, ms];
    }
  },
);

function onTriggerClick() {
  if (props.disabled) return;
  isOpen.value = true;
}

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
  const secRaw = selectedValues[0];
  const msRaw = selectedValues[1];
  if (secRaw === undefined || secRaw === null || msRaw === undefined || msRaw === null) return;
  const sec = Number(secRaw);
  const ms = Number(msRaw);
  if (!Number.isFinite(sec) || !Number.isFinite(ms)) return;
  const totalMs = secAndMsToMs(sec, ms);
  emit("update:modelValue", totalMs);
}
</script>
