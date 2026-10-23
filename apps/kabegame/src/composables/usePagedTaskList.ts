import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import { normalizeTaskEvent, normalizeTaskRow, TASK_PAGE_SIZE } from "@/services/tasks";
import { fetchRunConfig } from "@/services/runConfigs";
import { kbEvent$, on, pathqlRequest$, usePathqlLookAll, type AutoConfigChangePayload } from "@/services/kbEvents";
import type { CrawlTask } from "@/stores/crawler";

export function usePagedTaskList(options: {
  basePath: () => string;
  /** 最新一次读取失败时通知，已有行保留。 */
  onError?: (error: unknown) => void;
}) {
  const items = shallowRef<CrawlTask[]>([]);
  const total = ref(0);
  const active = ref(false);
  const page = ref(1);
  const landedPage = ref(0);
  const { showLoading, startLoading, finishLoading } = useLoadingDelay();
  const lastProgressUpdateAt = new Map<string, number>();

  const looker = usePathqlLookAll({
    queries: () =>
      active.value
        ? ([
            { kind: "fetch", path: `tasks://${options.basePath()}x${page.value * TASK_PAGE_SIZE}x/1` },
            { kind: "count", path: `tasks://${options.basePath().replace(/\/$/, "")}` },
          ] as const)
        : null,
    refreshOn: [
      on("tasks-change", (payload) => {
        const event = normalizeTaskEvent(payload);
        return (
          !!event && (event.type !== "TaskChanged" || Object.prototype.hasOwnProperty.call(event.diff, "startTime"))
        );
      }),
    ],
    onResult: ([rows, count]) => {
      items.value = rows.map(normalizeTaskRow).filter((task): task is CrawlTask => task !== null);
      total.value = count;
      landedPage.value = page.value;
    },
    onError: options.onError,
  });
  const hasMore = computed(
    () =>
      landedPage.value > 0 &&
      items.value.length >= landedPage.value * TASK_PAGE_SIZE &&
      items.value.length < total.value,
  );
  watch(looker.loading, (loading) => (loading ? startLoading() : finishLoading()), { flush: "sync" });

  function refresh() {
    const key = looker.key();
    if (key) pathqlRequest$.next(["all", key]);
  }

  function start() {
    active.value = true;
    page.value = 1;
    landedPage.value = 0;
    items.value = [];
    total.value = 0;
    lastProgressUpdateAt.clear();
    refresh();
  }

  function loadMore() {
    if (looker.loading.value || !hasMore.value) return;
    // 失败后仍以已落地页为基准，重试同一个累计窗口。
    page.value = landedPage.value + 1;
    refresh();
  }

  function replaceAt(index: number, task: CrawlTask) {
    const next = items.value.slice();
    next[index] = task;
    items.value = next;
  }

  function patch(id: string, fields: Partial<CrawlTask>) {
    const index = items.value.findIndex((task) => task.id === id);
    if (index === -1) return;
    replaceAt(index, { ...items.value[index], ...fields });
  }

  const taskPatches = kbEvent$("tasks-change").subscribe(({ payload }) => {
    if (!active.value) return;
    const event = normalizeTaskEvent(payload);
    if (event?.type !== "TaskChanged") return;
    const index = items.value.findIndex((task) => task.id === event.taskId);
    if (index === -1) return;
    const current = items.value[index];
    const normalized = event.diff;
    if (normalized.progress != null) {
      const keys = (Object.keys(normalized) as (keyof CrawlTask)[]).filter((key) => normalized[key] != null);
      const onlyProgress = keys.length > 0 && keys.every((key) => key === "progress");
      if (onlyProgress) {
        if (normalized.progress <= current.progress) return;
        const now = Date.now();
        if (normalized.progress < 100 && now - (lastProgressUpdateAt.get(event.taskId) ?? 0) < 100) return;
        lastProgressUpdateAt.set(event.taskId, now);
      }
    }
    const status = normalized.status ?? current.status;
    replaceAt(index, {
      ...current,
      ...normalized,
      progress: status === "completed" ? 100 : (normalized.progress ?? current.progress),
    });
  });

  const configPatches = kbEvent$<AutoConfigChangePayload>("auto-config-change").subscribe(
    async ({ payload: event }) => {
      if (!active.value || !event.configId) return;
      if (event.reason === "configdelete") {
        items.value = items.value.map((task) =>
          task.runConfigId === event.configId ? { ...task, runConfigName: null } : task,
        );
        return;
      }
      if (event.reason !== "configchange") return;
      try {
        const config = await fetchRunConfig(event.configId);
        if (!active.value) return;
        items.value = items.value.map((task) =>
          task.runConfigId === event.configId ? { ...task, runConfigName: config?.name ?? null } : task,
        );
      } catch (error) {
        console.error("读取任务关联配置失败:", error);
      }
    },
  );

  function stop() {
    active.value = false;
    landedPage.value = 0;
    items.value = [];
    total.value = 0;
    finishLoading();
    lastProgressUpdateAt.clear();
  }

  onScopeDispose(() => {
    stop();
    taskPatches.unsubscribe();
    configPatches.unsubscribe();
  });
  return { items, total, loading: looker.loading, showLoading, hasMore, start, loadMore, stop, patch, refresh };
}
