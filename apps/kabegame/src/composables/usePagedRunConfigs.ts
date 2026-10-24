import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import { kbEvent$, on, pathqlRequest$, usePathqlLookAll } from "@/services/kbEvents";
import {
  isRunConfigTaskSignal,
  lastResultOf,
  normalizeRunConfigRow,
  RUN_CONFIG_PAGE_SIZE,
} from "@/services/runConfigs";
import { normalizeTaskEvent } from "@/services/tasks";
import type { RunConfig, RunConfigLastTask } from "@/stores/crawler";

export function usePagedRunConfigs(options: {
  basePath: () => string;
  countPath: () => string;
  /** 最新一次读取（首读、加载更多或事件刷新）失败时通知，已有行保留。 */
  onError?: (error: unknown) => void;
}) {
  const items = shallowRef<RunConfig[]>([]);
  const total = ref(0);
  const active = ref(false);
  const page = ref(1);
  const landedPage = ref(0);
  const { showLoading, startLoading, finishLoading } = useLoadingDelay();

  const looker = usePathqlLookAll({
    queries: () =>
      active.value
        ? ([
            { kind: "fetch", path: `run_configs://${options.basePath()}x${page.value * RUN_CONFIG_PAGE_SIZE}x/1` },
            { kind: "count", path: `run_configs://${options.countPath().replace(/\/$/, "")}` },
          ] as const)
        : null,
    refreshOn: [on("auto-config-change"), on("tasks-change", isRunConfigTaskSignal)],
    onResult: ([rows, count]) => {
      items.value = rows.map(normalizeRunConfigRow).filter((config): config is RunConfig => config !== null);
      total.value = count;
      landedPage.value = page.value;
    },
    onError: options.onError,
  });
  const hasMore = computed(
    () =>
      landedPage.value > 0 &&
      items.value.length >= landedPage.value * RUN_CONFIG_PAGE_SIZE &&
      items.value.length < total.value,
  );
  watch(looker.loading, (loading) => (loading ? startLoading() : finishLoading()), { flush: "sync" });

  function request() {
    const key = looker.key();
    if (key) pathqlRequest$.next(["all", key]);
  }

  function start() {
    active.value = true;
    page.value = 1;
    landedPage.value = 0;
    items.value = [];
    total.value = 0;
    request();
  }

  function loadMore() {
    if (looker.loading.value || !hasMore.value) return;
    // 失败后仍以已落地页为基准，重试同一个累计窗口。
    page.value = landedPage.value + 1;
    request();
  }

  const patches = kbEvent$("tasks-change").subscribe(({ payload }) => {
    if (!active.value) return;
    const event = normalizeTaskEvent(payload);
    if (event?.type !== "TaskChanged") return;
    const index = items.value.findIndex((config) => config.lastTask?.id === event.taskId);
    if (index === -1) return;
    const current = items.value[index];
    const fields: Partial<RunConfigLastTask> = {};
    // 只补丁配置卡片已有的展示字段，进度与其它任务字段不进入 lastTask。
    for (const key of ["status", "endTime", "successCount", "failedCount", "error"] as const) {
      if (event.diff[key] !== undefined) Object.assign(fields, { [key]: event.diff[key] });
    }
    if (!Object.keys(fields).length) return;
    const lastTask = { ...current.lastTask!, ...fields };
    const next = items.value.slice();
    next[index] = { ...current, lastTask, lastResult: lastResultOf(lastTask) };
    items.value = next;
  });

  function stop() {
    active.value = false;
    landedPage.value = 0;
    items.value = [];
    total.value = 0;
    finishLoading();
  }

  onScopeDispose(() => {
    stop();
    patches.unsubscribe();
  });
  return { items, total, loading: looker.loading, showLoading, hasMore, start, loadMore, stop };
}
