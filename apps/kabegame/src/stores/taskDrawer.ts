import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { IS_WEB } from "@/env";
import { trackEvent } from "@/track/umami";
import { normalizeTaskEvent } from "@/services/tasks";
import { on, pathqlRequest$, usePathqlLookAll } from "@/services/kbEvents";

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

export const useTaskDrawerStore = defineStore("taskDrawer", () => {
  const visible = ref(false);
  const search = ref("");
  const statusCounts = ref<Record<string, number>>({});
  const countsLooker = usePathqlLookAll({
    queries: () => [{ kind: "list", path: "tasks://status" }] as const,
    refreshOn: [
      on("tasks-change", (payload) => {
        const event = normalizeTaskEvent(payload);
        return !!event && (event.type !== "TaskChanged" || Object.prototype.hasOwnProperty.call(event.diff, "status"));
      }),
    ],
    onResult: ([entries]) => {
      statusCounts.value = Object.fromEntries(
        entries.map((entry) => [entry.name, Number((entry.meta as Record<string, unknown> | null)?.count ?? 0)]),
      );
    },
  });

  const sum = (statuses: string[]) => statuses.reduce((total, status) => total + (statusCounts.value[status] ?? 0), 0);

  // 右上角徽章显示：排队中 + 运行中
  const activeTasksCount = computed(() => sum(["pending", "running", "waiting_downloads"]));
  const finishedTasksCount = computed(() => sum(["completed", "failed", "canceled"]));
  const allTasksCount = computed(() => activeTasksCount.value + finishedTasksCount.value);

  function refreshCounts() {
    const key = countsLooker.key();
    if (key) pathqlRequest$.next(["all", key]);
  }
  refreshCounts();

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
