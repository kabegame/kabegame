<template>
  <div class="relative min-w-0 flex-1 select-none" :style="{ height: `${ITEM_H * VISIBLE}px` }">
    <!-- 选中带：在列表底下，文字压在上面 -->
    <div
      class="pointer-events-none absolute inset-x-1 rounded-kb-md bg-kb-hover"
      :style="{ top: `${PAD}px`, height: `${ITEM_H}px` }"
    />
    <div
      ref="scrollRef"
      role="listbox"
      tabindex="0"
      :aria-label="ariaLabel"
      :aria-activedescendant="options.length ? `${uid}-${centerIndex}` : undefined"
      class="relative box-border h-full snap-y snap-mandatory overflow-y-auto overscroll-contain outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:ring-2 focus-visible:ring-kb-ring rounded-kb-md"
      :style="{ paddingBlock: `${PAD}px` }"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
    >
      <div
        v-for="(option, index) in options"
        :id="`${uid}-${index}`"
        :key="String(option.value)"
        role="option"
        :aria-selected="index === centerIndex"
        class="flex snap-center items-center justify-center truncate px-2 text-[16px] tabular-nums transition-colors duration-100"
        :class="index === centerIndex ? 'font-500 text-kb-fg' : 'text-kb-fg-subtle'"
        :style="{ height: `${ITEM_H}px` }"
        @click="scrollToIndex(index, true)"
      >
        {{ option.text }}
      </div>
    </div>
    <!-- 上下渐隐 -->
    <div
      class="pointer-events-none absolute inset-x-0 top-0 bg-[linear-gradient(180deg,var(--kb-surface-raised),transparent)]"
      :style="{ height: `${PAD}px` }"
    />
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,var(--kb-surface-raised),transparent)]"
      :style="{ height: `${PAD}px` }"
    />
  </div>
</template>

<script setup lang="ts" generic="V extends string | number">
/**
 * 滚轮的一列（PickerSheet 用）：原生滚动 + scroll-snap，惯性与回弹交给浏览器。
 * 停稳后发 update:modelValue；点某一项滚到它；方向键逐项移动。值不在选项里时停在第一项。
 * settle() 立即按当前滚动位置取值（惯性还没停时点「确定」用）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";

export interface WheelOption<T> {
  text: string;
  value: T;
}

const ITEM_H = 44;
const VISIBLE = 5;
const PAD = ITEM_H * Math.floor(VISIBLE / 2);
/** 最后一次 scroll 事件之后这么久没有新的就算停稳（scrollend 不是所有 WebView 都有） */
const SETTLE_MS = 120;

const props = defineProps<{ options: WheelOption<V>[]; ariaLabel?: string }>();
const model = defineModel<V>();

const uid = useId();
const scrollRef = ref<HTMLElement | null>(null);
const centerIndex = ref(0);
let settleTimer: number | null = null;
/** 自己发出去的值回流时不再滚动 */
let emitted: V | undefined;

const selectedIndex = computed(() => {
  const index = props.options.findIndex((o) => o.value === model.value);
  return index === -1 ? 0 : index;
});

function clampIndex(index: number) {
  return Math.max(0, Math.min(props.options.length - 1, index));
}

function indexAtScroll(): number {
  const el = scrollRef.value;
  return el ? clampIndex(Math.round(el.scrollTop / ITEM_H)) : selectedIndex.value;
}

function scrollToIndex(index: number, smooth = false) {
  const el = scrollRef.value;
  if (!el) return;
  centerIndex.value = index;
  el.scrollTo({ top: index * ITEM_H, behavior: smooth ? "smooth" : "auto" });
}

function commit(index: number) {
  const option = props.options[index];
  if (!option) return;
  if (option.value !== model.value) {
    emitted = option.value;
    model.value = option.value;
  }
}

function onScroll() {
  centerIndex.value = indexAtScroll();
  if (settleTimer != null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    commit(indexAtScroll());
  }, SETTLE_MS);
}

function onKeydown(e: KeyboardEvent) {
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    scrollToIndex(e.key === "Home" ? 0 : props.options.length - 1, true);
    return;
  }
  if (!step) return;
  e.preventDefault();
  scrollToIndex(clampIndex(centerIndex.value + step), true);
}

/** 立即按当前位置取值并发出；返回选中的值 */
function settle(): V | undefined {
  if (settleTimer != null) {
    window.clearTimeout(settleTimer);
    settleTimer = null;
  }
  const index = indexAtScroll();
  commit(index);
  return props.options[index]?.value;
}

// 外部改值、换了一批选项：对齐到选中项（自己发出的值不算）
watch([selectedIndex, () => props.options], () => {
  if (emitted !== undefined && emitted === model.value) {
    emitted = undefined;
    return;
  }
  void nextTick(() => scrollToIndex(selectedIndex.value));
});

onMounted(() => scrollToIndex(selectedIndex.value));
onBeforeUnmount(() => {
  if (settleTimer != null) window.clearTimeout(settleTimer);
});

defineExpose({ settle });
</script>
