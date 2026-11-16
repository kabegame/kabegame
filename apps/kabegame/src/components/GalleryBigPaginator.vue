<template>
  <div
    v-if="showPaginator"
    class="gallery-big-paginator z-99 box-border border-0 border-b border-solid border-kb-line bg-kb-surface px-3 py-2 backdrop-blur-xl backdrop-saturate-150"
    :class="{ 'is-sticky sticky top-16 shadow-kb-sm': isSticky, 'is-android': isCompact }"
  >
    <Paginator
      class="mx-auto max-w-[1200px] justify-between"
      :page="currentBigPage"
      :page-count="totalBigPages"
      :compact="isCompact"
      @update:page="emit('jumpToPage', $event)"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 画廊、画册、任务详情、畅游的大页翻页条：外框（底边线、毛玻璃底、可吸顶）+ 只有一页时隐藏，
 * 翻页本身是 `@/components/ui` 的 `Paginator`（触屏布局跟随 `useUiStore().isCompact`）。
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Paginator } from "@/components/ui";
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

const { isCompact } = storeToRefs(useUiStore());

/** 总共有多少大页 */
const totalBigPages = computed(() => Math.max(1, Math.ceil(props.totalCount / props.bigPageSize)));

/** 当前在第几大页（从 1 开始） */
const currentBigPage = computed(() => Math.max(1, props.currentPage || 1));

/** 总数超过一页才显示 */
const showPaginator = computed(() => props.totalCount > props.bigPageSize);
</script>
