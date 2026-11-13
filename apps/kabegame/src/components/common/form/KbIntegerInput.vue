<template>
  <div class="kb-control h-8 min-w-0 overflow-hidden" :data-disabled="disabled || undefined">
    <button
      type="button"
      class="grid h-full w-8 shrink-0 cursor-pointer place-items-center border-0 border-r border-r-solid border-r-kb-line bg-transparent p-0 text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      :disabled="decreaseDisabled"
      :aria-label="t('common.decrease')"
      @click="step(-1)"
    >
      <Minus class="size-3.5" />
    </button>
    <input
      class="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-center text-inherit tabular-nums outline-none [font:inherit] placeholder:text-kb-fg-subtle"
      type="text"
      inputmode="numeric"
      :id="field.id.value"
      :aria-invalid="field.invalid.value || undefined"
      :aria-describedby="field.describedBy.value"
      :value="inputText"
      :placeholder="placeholder"
      :title="placeholder"
      :disabled="disabled"
      @input="onInput"
      @blur="commit"
      @keydown.enter="commit"
    />
    <button
      type="button"
      class="grid h-full w-8 shrink-0 cursor-pointer place-items-center border-0 border-l border-l-solid border-l-kb-line bg-transparent p-0 text-kb-fg-muted hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      :disabled="increaseDisabled"
      :aria-label="t('common.increase')"
      @click="step(1)"
    >
      <Plus class="size-3.5" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Minus, Plus } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useFieldControl } from "@/components/ui/field";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    min?: number;
    max?: number;
    placeholder?: string;
    /** 按钮步进量，默认 1 */
    step?: number;
    disabled?: boolean;
  }>(),
  { step: 1, disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: number | string];
  /**
   * 提交语义（对齐 el-input-number 的 change）：按钮步进、失焦、回车时发出。
   * 键入的整数会 clamp 进范围；文本不是整数时发 undefined，由调用方决定回退。
   * 只发事件、不改写 modelValue——需要「保存一次」的调用方（如设置项）监听它而非 update:modelValue。
   */
  change: [value: number | undefined];
}>();

const { t } = useI18n();
// 放在 Field 里时拿 id / 出错状态（描红由外框的 data-invalid 负责）；校验由 Field 的 validator 随值实时跟随
const field = useFieldControl({});
const inputText = ref(formatValue(props.modelValue));

const numberValue = computed(() =>
  typeof props.modelValue === "number" && Number.isFinite(props.modelValue) && Number.isInteger(props.modelValue)
    ? props.modelValue
    : undefined,
);
const hasMin = computed(() => typeof props.min === "number" && Number.isFinite(props.min));
const hasMax = computed(() => typeof props.max === "number" && Number.isFinite(props.max));
const decreaseDisabled = computed(
  () =>
    props.disabled || numberValue.value === undefined || (hasMin.value && numberValue.value <= (props.min as number)),
);
const increaseDisabled = computed(
  () =>
    props.disabled || numberValue.value === undefined || (hasMax.value && numberValue.value >= (props.max as number)),
);

function clamp(value: number): number {
  let v = value;
  if (hasMin.value) v = Math.max(props.min as number, v);
  if (hasMax.value) v = Math.min(props.max as number, v);
  return v;
}

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
  // clamp 而非越界即放弃：步进量 > 1 时仍能走到边界值（如 step=10 时 1435 → 1440）
  const next = clamp(current + direction * props.step);
  if (next === current) return;
  inputText.value = String(next);
  emit("update:modelValue", next);
  emit("change", next);
}

function commit() {
  const parsed = parseInput(inputText.value.trim());
  emit("change", typeof parsed === "number" ? clamp(parsed) : undefined);
}

watch(
  () => [props.modelValue, props.min, props.max] as const,
  ([value], [previousValue]) => {
    if (!Object.is(value, previousValue)) inputText.value = formatValue(value);
  },
);
</script>
