import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useCrawlerStore } from "./crawler";
import { IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

export const useTaskDrawerStore = defineStore("taskDrawer", () => {
  const visible = ref(false);
  const crawlerStore = useCrawlerStore();

  // 获取所有任务（包括排队中、运行中、失败、取消和已完成的任务）
  const tasks = computed(() => {
    return crawlerStore.tasks.filter(
      (task) =>
        task.status === "pending" ||
        task.status === "running" ||
        task.status === "waiting_downloads" ||
        task.status === "failed" ||
        task.status === "canceled" ||
        task.status === "completed"
    );
  });

  // 右上角徽章显示：排队中 + 运行中
  const activeTasksCount = computed(() => {
    return crawlerStore.tasks.filter(
      (task) =>
        task.status === "pending" ||
        task.status === "running" ||
        task.status === "waiting_downloads"
    ).length;
  });

  function open() {
    if (IS_WEB && !visible.value) {
      trackEvent("task_drawer_toggle", {
        action: "open",
        url: currentUrl(),
        active_task_count: activeTasksCount.value,
        task_count: tasks.value.length,
      });
    }
    visible.value = true;
  }

  function close() {
    if (IS_WEB && visible.value) {
      trackEvent("task_drawer_toggle", {
        action: "close",
        url: currentUrl(),
        active_task_count: activeTasksCount.value,
        task_count: tasks.value.length,
      });
    }
    visible.value = false;
  }

  function toggle() {
    if (visible.value) {
      close();
    } else {
      open();
    }
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
