import { defineStore } from "pinia";
import { ref, computed } from "vue";

/**
 * 全局选择状态：跨分页共享的 selectedIds。
 * 长度为 0 即无选择状态，不需要单独的 clear 函数。
 */
export const useSelectionStore = defineStore("selection", () => {
  const selectedIds = ref<Set<string>>(new Set());
  const active = computed(() => selectedIds.value.size > 0);

  return {
    selectedIds,
    active,
  };
});
