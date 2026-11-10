import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import { normalizeTaskEvent, normalizeTaskRow, TASK_PAGE_SIZE } from "@/services/tasks";
import { on, pathqlRequest$, usePathqlLookAll } from "@/services/kbEvents";
import { useTaskRowPatches } from "@/composables/useTaskRowPatches";
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
  const { patch, reset: resetPatches } = useTaskRowPatches(items, active);

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
    resetPatches();
    refresh();
  }

  function loadMore() {
    if (looker.loading.value || !hasMore.value) return;
    // 失败后仍以已落地页为基准，重试同一个累计窗口。
    page.value = landedPage.value + 1;
    refresh();
  }

  function stop() {
    active.value = false;
    landedPage.value = 0;
    items.value = [];
    total.value = 0;
    finishLoading();
    resetPatches();
  }

  onScopeDispose(stop);
  return { items, total, loading: looker.loading, showLoading, hasMore, start, loadMore, stop, patch, refresh };
}
