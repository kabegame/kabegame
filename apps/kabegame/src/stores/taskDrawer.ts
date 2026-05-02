import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useCrawlerStore } from "./crawler";

export const useTaskDrawerStore = defineStore("taskDrawer", () => {
  const visible = ref(false);
  const crawlerStore = useCrawlerStore();

  // 获取所有任务（包括排队中、运行中、失败、取消和已完成的任务）
  const tasks = computed(() => {
    return crawlerStore.tasks.filter(
      (task) =>
        task.status === "pending" ||
        task.status === "running" ||
        task.status === "failed" ||
        task.status === "canceled" ||
        task.status === "completed"
    );
  });

  // 右上角徽章显示：排队中 + 运行中
  const activeTasksCount = computed(() => {
    return crawlerStore.tasks.filter(
      (task) => task.status === "pending" || task.status === "running"
    ).length;
  });

  function open() {
    visible.value = true;
  }

  function close() {
    visible.value = false;
  }

  function toggle() {
    visible.value = !visible.value;
  }

  return {
    visible,
    tasks,
    activeTasksCount,
    open,
    close,
    toggle,
  };
});

