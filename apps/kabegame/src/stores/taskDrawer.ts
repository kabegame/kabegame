import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { IS_WEB } from "@/env";
import { trackEvent } from "@/track/umami";
import { fetchTaskStatusCounts, subscribeTaskEvents } from "@/services/tasks";

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

export const useTaskDrawerStore = defineStore("taskDrawer", () => {
  const visible = ref(false);
  const search = ref("");
  const statusCounts = ref<Record<string, number>>({});
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const sum = (statuses: string[]) => statuses.reduce((total, status) => total + (statusCounts.value[status] ?? 0), 0);

  // 右上角徽章显示：排队中 + 运行中
  const activeTasksCount = computed(() => sum(["pending", "running", "waiting_downloads"]));
  const finishedTasksCount = computed(() => sum(["completed", "failed", "canceled"]));
  const allTasksCount = computed(() => activeTasksCount.value + finishedTasksCount.value);

  async function refreshCounts() {
    statusCounts.value = await fetchTaskStatusCounts();
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshCounts();
    }, 300);
  }

  subscribeTaskEvents((event) => {
    if (event.type === "TaskAdded" || event.type === "TaskDeleted") scheduleRefresh();
    else if (Object.prototype.hasOwnProperty.call(event.diff, "status")) scheduleRefresh();
  });
  void refreshCounts();

  function open() {
    if (IS_WEB && !visible.value) {
      trackEvent("task_drawer_toggle", {
        action: "open",
        url: currentUrl(),
        active_task_count: activeTasksCount.value,
        task_count: allTasksCount.value,
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
        task_count: allTasksCount.value,
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
    search,
    statusCounts,
    activeTasksCount,
    finishedTasksCount,
    refreshCounts,
    open,
    close,
    toggle,
  };
});
