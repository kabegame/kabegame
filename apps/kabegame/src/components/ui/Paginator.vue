<template>
  <div class="flex items-center gap-3">
    <Button
      variant="ghost"
      :size="compact ? 'icon-sm' : 'sm'"
      :disabled="disabled || current <= 1"
      :aria-label="t('common.prevPage')"
      @click="go(current - 1)"
    >
      <ChevronLeft />
      <span v-if="!compact">{{ t("common.prevPage") }}</span>
    </Button>

    <!-- 页码：桌面是可输入的当前页 / 总页数；compact 点开滚轮选择（按总页数位数多列） -->
    <div
      class="flex h-8 items-center rounded-kb-md border border-solid border-kb-line-strong bg-kb-surface-raised text-[13px] tabular-nums"
    >
      <template v-if="!compact">
        <input
          ref="pageInputRef"
          v-model="inputText"
          type="text"
          inputmode="numeric"
          class="h-full min-w-10 rounded-l-kb-md border-0 bg-transparent px-1 text-center text-[13px] font-600 text-kb-fg outline-none [font-family:inherit] focus:bg-kb-hover"
          :style="{ width: `${String(total).length + 2.5}ch` }"
          :disabled="disabled"
          :aria-label="t('common.jumpToPage')"
          @keydown.enter.prevent="commitInput(true)"
          @keydown.esc.prevent="resetInput(true)"
          @blur="commitInput(false)"
        />
        <span class="text-kb-fg-subtle" aria-hidden="true">/</span>
        <span class="px-2.5 text-kb-fg-muted">{{ total }}</span>
      </template>
      <button
        v-else
        type="button"
        class="flex h-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] tabular-nums [font-family:inherit]"
        :disabled="disabled"
        :aria-label="t('common.jumpToPage')"
        @click="pickerOpen = true"
      >
        <span class="font-600 text-kb-fg">{{ current }}</span>
        <span class="text-kb-fg-subtle">/</span>
        <span class="text-kb-fg-muted">{{ total }}</span>
      </button>
    </div>

    <Button
      variant="ghost"
      :size="compact ? 'icon-sm' : 'sm'"
      :disabled="disabled || current >= total"
      :aria-label="t('common.nextPage')"
      @click="go(current + 1)"
    >
      <span v-if="!compact">{{ t("common.nextPage") }}</span>
      <ChevronRight />
    </Button>

    <PickerSheet
      v-if="compact"
      v-model:open="pickerOpen"
      v-model="pickerSelectedValues"
      :title="t('common.jumpToPage')"
      :columns="pickerColumns"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 翻页：上一页 / 当前页 / 总页数 / 下一页（v-model:page，从 1 起；`pageCount` 是总页数）。
 * 桌面的当前页是输入框，回车或失焦时按 1～总页数收拢后跳转、不是数字就复原；`compact`（触屏）点开底部滚轮，
 * 按总页数每 10 倍一列级联选。只管翻页本身，外框、吸顶与「只有一页时隐藏」由调用方决定（画廊见 `GalleryBigPaginator`）。
 */
import { computed, ref, watch } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import Button from "./Button.vue";
import PickerSheet from "./PickerSheet.vue";

const props = withDefaults(
  defineProps<{
    /** 总页数，至少按 1 算 */
    pageCount: number;
    /** 触屏布局：按钮只有图标，页码点开滚轮 */
    compact?: boolean;
    disabled?: boolean;
  }>(),
  { compact: false, disabled: false },
);

const page = defineModel<number>("page", { default: 1 });

const { t } = useI18n();

const total = computed(() => Math.max(1, Math.floor(props.pageCount) || 1));
const current = computed(() => Math.min(total.value, Math.max(1, page.value || 1)));

function go(target: number) {
  const next = Math.max(1, Math.min(total.value, target));
  if (next !== current.value) page.value = next;
}

// --- 桌面：可输入的当前页 ---
const pageInputRef = ref<HTMLInputElement | null>(null);
const inputText = ref(String(current.value));

watch(current, (value) => {
  inputText.value = String(value);
});

function resetInput(blur: boolean) {
  inputText.value = String(current.value);
  if (blur) pageInputRef.value?.blur();
}

function commitInput(blur: boolean) {
  const target = Number.parseInt(inputText.value.trim(), 10);
  if (Number.isNaN(target)) {
    resetInput(blur);
    return;
  }
  go(target);
  inputText.value = String(Math.max(1, Math.min(total.value, target)));
  if (blur) pageInputRef.value?.blur();
}

// --- compact：滚轮选择按总页数每 10 倍一列 ---
const pickerOpen = ref(false);

/** 总页数的位数，即滚轮列数（1–9→1 列，10–99→2 列，100–999→3 列…） */
const pickerDigitCount = computed(() => {
  const count = total.value;
  return count < 10 ? 1 : Math.floor(Math.log10(count)) + 1;
});

/** 级联选项（保证选中值在 1～总页数） */
interface PickerCascadeOption {
  text: string;
  value: number;
  children?: PickerCascadeOption[];
}

/** 构建级联列：最小 1、最大 count，避免出现 0 或超过总页数 */
function buildCascadeColumns(count: number, n: number): PickerCascadeOption[] {
  if (n === 1) {
    return Array.from({ length: count }, (_, i) => ({ text: String(i + 1), value: i + 1 }));
  }
  const maxFirst = Math.min(9, Math.floor(count / Math.pow(10, n - 1)));
  const options: PickerCascadeOption[] = [];
  for (let d0 = 0; d0 <= maxFirst; d0++) {
    const base = d0 * Math.pow(10, n - 1);
    const restMax = count - base;
    const restMin = d0 === 0 ? 1 : 0;
    const childScale = Math.pow(10, n - 2);
    const children = buildCascadeLevel(restMin, Math.min(restMax, Math.pow(10, n - 1) - 1), n - 1, childScale);
    options.push({ text: String(d0), value: d0, children });
  }
  return options;
}

function buildCascadeLevel(minRest: number, maxRest: number, depth: number, scale: number): PickerCascadeOption[] {
  if (depth <= 0 || scale < 1) return [];
  if (depth === 1) {
    const low = Math.max(0, minRest);
    const high = Math.min(9, maxRest);
    return Array.from({ length: high - low + 1 }, (_, i) => {
      const v = low + i;
      return { text: String(v), value: v };
    });
  }
  const nextScale = scale / 10;
  const low = Math.max(0, Math.floor(minRest / scale));
  const high = Math.min(9, Math.floor(maxRest / scale));
  const options: PickerCascadeOption[] = [];
  for (let d = low; d <= high; d++) {
    const subMin = Math.max(0, minRest - d * scale);
    const subMax = Math.min(scale - 1, maxRest - d * scale);
    const children = buildCascadeLevel(subMin, subMax, depth - 1, nextScale);
    if (children.length > 0) {
      options.push({ text: String(d), value: d, children });
    }
  }
  return options;
}

/** 滚轮各列选项：单列为 [ [{text,value},...] ]，多列为级联数组（保证 1～总页数） */
const pickerColumns = computed(() => {
  const n = pickerDigitCount.value;
  const result = buildCascadeColumns(total.value, n);
  return n === 1 ? [result] : result;
});

/** 把页码拆成各位数字（滚轮的 v-model） */
function pageToDigitValues(value: number, digitCount: number): number[] {
  const clamped = Math.max(1, Math.min(value, total.value));
  if (digitCount === 1) return [clamped];
  const digits: number[] = [];
  let rest = clamped;
  for (let i = 0; i < digitCount; i++) {
    digits.unshift(rest % 10);
    rest = Math.floor(rest / 10);
  }
  return digits;
}

/** 各列选中的值拼回页码 */
function digitValuesToPage(values: (string | number)[]): number {
  return values.reduce<number>((acc, value) => acc * 10 + Number(value), 0);
}

/** 滚轮当前选中值（打开时与当前页同步） */
const pickerSelectedValues = ref<number[]>([]);

watch(pickerOpen, (open) => {
  if (open) pickerSelectedValues.value = pageToDigitValues(current.value, pickerDigitCount.value);
});

watch([current, pickerDigitCount], () => {
  if (pickerOpen.value) pickerSelectedValues.value = pageToDigitValues(current.value, pickerDigitCount.value);
});

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
  go(digitValuesToPage(selectedValues));
}
</script>
