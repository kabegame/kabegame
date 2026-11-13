<template>
  <div
    v-if="showPaginator"
    class="gallery-big-paginator z-99 box-border border-0 border-b border-solid border-kb-line bg-kb-surface px-3 py-2 backdrop-blur-xl backdrop-saturate-150"
    :class="{ 'is-sticky sticky top-16 shadow-kb-sm': isSticky, 'is-android': isCompact }"
  >
    <div class="mx-auto flex max-w-[1200px] items-center justify-between gap-3">
      <Button
        variant="ghost"
        :size="isCompact ? 'icon-sm' : 'sm'"
        :disabled="currentBigPage === 1"
        :aria-label="$t('gallery.prevPage')"
        @click="handlePrevPage"
      >
        <ChevronLeft />
        <span v-if="!isCompact">{{ $t("gallery.prevPage") }}</span>
      </Button>

      <!-- 页码：桌面是可输入的当前页 / 总页数；Android 点开滚轮选择（按总页数位数多列） -->
      <div
        class="flex h-8 items-center rounded-kb-md border border-solid border-kb-line-strong bg-kb-surface-raised text-[13px] tabular-nums"
      >
        <template v-if="!isCompact">
          <input
            ref="pageInputRef"
            v-model="inputText"
            type="text"
            inputmode="numeric"
            class="h-full min-w-10 rounded-l-kb-md border-0 bg-transparent px-1 text-center text-[13px] font-600 text-kb-fg outline-none [font-family:inherit] focus:bg-kb-hover"
            :style="{ width: `${String(totalBigPages).length + 2.5}ch` }"
            :aria-label="$t('gallery.jumpToPage')"
            @keydown.enter.prevent="commitInput(true)"
            @keydown.esc.prevent="resetInput(true)"
            @blur="commitInput(false)"
          />
          <span class="text-kb-fg-subtle" aria-hidden="true">/</span>
          <span class="px-2.5 text-kb-fg-muted">{{ totalBigPages }}</span>
        </template>
        <button
          v-else
          type="button"
          class="flex h-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 text-[13px] tabular-nums [font-family:inherit]"
          :aria-label="$t('gallery.jumpToPage')"
          @click="pagePickerOpen = true"
        >
          <span class="font-600 text-kb-fg">{{ currentBigPage }}</span>
          <span class="text-kb-fg-subtle">/</span>
          <span class="text-kb-fg-muted">{{ totalBigPages }}</span>
        </button>
      </div>

      <Button
        variant="ghost"
        :size="isCompact ? 'icon-sm' : 'sm'"
        :disabled="currentBigPage === totalBigPages"
        :aria-label="$t('gallery.nextPage')"
        @click="handleNextPage"
      >
        <span v-if="!isCompact">{{ $t("gallery.nextPage") }}</span>
        <ChevronRight />
      </Button>
    </div>

    <PickerSheet
      v-if="isCompact"
      v-model:open="pagePickerOpen"
      v-model="pickerSelectedValues"
      :title="$t('gallery.jumpToPage')"
      :columns="pickerColumns"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { Button, PickerSheet } from "@/components/ui";
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";

interface Props {
  totalCount: number;
  currentPage: number;
  bigPageSize?: number;
  isSticky?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  currentPage: 1,
  bigPageSize: 10000,
  isSticky: false,
});

const emit = defineEmits<{
  jumpToPage: [page: number];
}>();

const BIG_PAGE_SIZE = computed(() => props.bigPageSize);
const { isCompact } = storeToRefs(useUiStore());

// 总共有多少大页
const totalBigPages = computed(() => {
  return Math.max(1, Math.ceil(props.totalCount / BIG_PAGE_SIZE.value));
});

// 当前在第几大页（从1开始）
const currentBigPage = computed(() => {
  return Math.max(1, props.currentPage || 1);
});

// 是否显示分页器（总数超过一页才显示）
const showPaginator = computed(() => {
  return props.totalCount > BIG_PAGE_SIZE.value;
});

const pageInputRef = ref<HTMLInputElement | null>(null);
// 跳转输入框的文字（桌面）：回车或失焦时按 1～总页数收拢后跳转，输入的不是数字就复原
const inputText = ref(String(currentBigPage.value));

watch(currentBigPage, (page) => {
  inputText.value = String(page);
});

function resetInput(blur: boolean) {
  inputText.value = String(currentBigPage.value);
  if (blur) pageInputRef.value?.blur();
}

function commitInput(blur: boolean) {
  const page = Number.parseInt(inputText.value.trim(), 10);
  if (Number.isNaN(page)) {
    resetInput(blur);
    return;
  }
  handleJumpToPage(page);
  inputText.value = String(Math.max(1, Math.min(totalBigPages.value, page)));
  if (blur) pageInputRef.value?.blur();
}

// --- Android：滚轮选择按总页数每 10 倍一列 ---
const pagePickerOpen = ref(false);

/** 总页数的位数，即 Picker 列数（1–9→1 列，10–99→2 列，100–999→3 列…） */
const pickerDigitCount = computed(() => {
  const total = totalBigPages.value;
  return total < 10 ? 1 : Math.floor(Math.log10(total)) + 1;
});

/** Picker 级联选项类型（保证选中值在 1～totalBigPages） */
interface PickerCascadeOption {
  text: string;
  value: number;
  children?: PickerCascadeOption[];
}

/** 构建级联列：最小 1、最大 total，避免出现 0 或超过总页数 */
function buildCascadeColumns(total: number, n: number): PickerCascadeOption[] | PickerCascadeOption[][] {
  if (n === 1) {
    return Array.from({ length: total }, (_, i) => ({
      text: String(i + 1),
      value: i + 1,
    }));
  }
  const maxFirst = Math.min(9, Math.floor(total / Math.pow(10, n - 1)));
  const options: PickerCascadeOption[] = [];
  for (let d0 = 0; d0 <= maxFirst; d0++) {
    const base = d0 * Math.pow(10, n - 1);
    const restMax = total - base;
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

/** Picker 各列选项：单列为 [ [{text,value},...] ]，多列为级联数组（保证 1～totalBigPages） */
const pickerColumns = computed(() => {
  const total = totalBigPages.value;
  const n = pickerDigitCount.value;
  const result = buildCascadeColumns(total, n);
  if (n === 1) {
    return [result as PickerCascadeOption[]];
  }
  return result as PickerCascadeOption[];
});

/** 将页码拆成各位数字数组（用于 Picker v-model） */
function pageToDigitValues(page: number, digitCount: number): number[] {
  const total = totalBigPages.value;
  if (digitCount === 1) {
    return [Math.max(1, Math.min(page, total))];
  }
  const arr: number[] = [];
  let p = Math.max(1, Math.min(page, total));
  for (let i = 0; i < digitCount; i++) {
    arr.unshift(p % 10);
    p = Math.floor(p / 10);
  }
  return arr;
}

/** 将各列选中的 value 组合成页码 */
function digitValuesToPage(values: (string | number)[]): number {
  let page = 0;
  for (let i = 0; i < values.length; i++) {
    page = page * 10 + Number(values[i]);
  }
  return page;
}

/** Picker 当前选中值（与 currentBigPage 同步，打开时写入） */
const pickerSelectedValues = ref<number[]>([]);

watch(pagePickerOpen, (v) => {
  if (v) {
    pickerSelectedValues.value = pageToDigitValues(currentBigPage.value, pickerDigitCount.value);
  }
});

watch([currentBigPage, pickerDigitCount], () => {
  if (pagePickerOpen.value) {
    pickerSelectedValues.value = pageToDigitValues(currentBigPage.value, pickerDigitCount.value);
  }
});

const onPickerConfirm = ({ selectedValues }: { selectedValues: (string | number)[] }) => {
  let page = digitValuesToPage(selectedValues);
  page = Math.max(1, Math.min(totalBigPages.value, page));
  if (page !== currentBigPage.value) {
    emit("jumpToPage", page);
  }
};

// 上一页
const handlePrevPage = () => {
  if (currentBigPage.value > 1) {
    emit("jumpToPage", currentBigPage.value - 1);
  }
};

// 下一页
const handleNextPage = () => {
  if (currentBigPage.value < totalBigPages.value) {
    emit("jumpToPage", currentBigPage.value + 1);
  }
};

// 跳转到指定页（桌面输入框）
function handleJumpToPage(page: number) {
  const targetPage = Math.max(1, Math.min(totalBigPages.value, page));
  if (targetPage !== currentBigPage.value) {
    emit("jumpToPage", targetPage);
  }
}
</script>
