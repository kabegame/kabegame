import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 收集抽屉的开关状态。
 *
 * 表单参数不再经这里传递：调用方先 `writeTaskConfig(...)` 写入全局 task config，
 * 再 `open()`；不写则自然是上次的值（或空表单）。
 */
export const useCrawlerDrawerStore = defineStore("crawlerDrawer", () => {
  const visible = ref(false);

  function open() {
    visible.value = true;
  }

  function close() {
    visible.value = false;
  }

  return {
    visible,
    open,
    close,
  };
});
