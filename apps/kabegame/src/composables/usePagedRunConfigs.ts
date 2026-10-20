import { onScopeDispose, ref, shallowRef } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import {
  compareRunConfigs,
  fetchRunConfig,
  fetchRunConfigPage,
  fetchRunConfigTotal,
  lastResultOf,
  lastTaskFromCrawlTask,
  RUN_CONFIG_PAGE_SIZE,
  subscribeRunConfigEvents,
  type RunConfigEvent,
  type RunConfigSort,
} from "@/services/runConfigs";
import { normalizeTaskRow, subscribeTaskEvents, type TaskEvent } from "@/services/tasks";
import type { RunConfig } from "@/stores/crawler";

export function usePagedRunConfigs(options: {
  basePath: () => string;
  countPath: () => string;
  matches: (config: RunConfig) => boolean;
  sort: () => { key: RunConfigSort; dir: "asc" | "desc" };
}) {
  const items = shallowRef<RunConfig[]>([]);
  const total = ref(0);
  const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();
  const hasMore = ref(false);
  let generation = 0;
  let page = 1;
  let unsubscribeConfig: (() => void) | null = null;
  let unsubscribeTasks: (() => void) | null = null;
  let countTimer: ReturnType<typeof setTimeout> | null = null;

  function comparator() {
    const { key, dir } = options.sort();
    return compareRunConfigs(key, dir);
  }

  function scheduleCountRefresh() {
    if (countTimer) clearTimeout(countTimer);
    const activeGeneration = generation;
    countTimer = setTimeout(async () => {
      countTimer = null;
      const count = await fetchRunConfigTotal(options.countPath());
      if (activeGeneration !== generation) return;
      total.value = count;
      hasMore.value = items.value.length < total.value;
    }, 200);
  }

  function remove(id: string, refreshCount = false) {
    if (!items.value.some((config) => config.id === id)) return false;
    items.value = items.value.filter((config) => config.id !== id);
    if (refreshCount) scheduleCountRefresh();
    return true;
  }

  function upsert(config: RunConfig, refreshCount = false) {
    const index = items.value.findIndex((item) => item.id === config.id);
    if (!options.matches(config)) {
      if (index !== -1) remove(config.id, refreshCount);
      return;
    }
    const next =
      index === -1 ? [...items.value, config] : items.value.map((item) => (item.id === config.id ? config : item));
    const seen = new Set<string>();
    items.value = next.sort(comparator()).filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    if (index === -1 || refreshCount) scheduleCountRefresh();
  }

  async function applyConfigEvent(event: RunConfigEvent, activeGeneration: number) {
    if (activeGeneration !== generation) return;
    if (event.reason === "configdelete") {
      remove(event.configId, true);
      return;
    }
    const config = await fetchRunConfig(event.configId);
    if (activeGeneration !== generation || !config) return;
    upsert(config, true);
  }

  // taskId → 配置 id：TaskChanged / TaskDeleted 不带 runConfigId，只能靠 TaskAdded 时记下
  const taskConfigIds = new Map<string, string>();

  async function refetchInto(configId: string, activeGeneration: number) {
    const config = await fetchRunConfig(configId);
    if (activeGeneration === generation && config) upsert(config, true);
  }

  async function applyTaskEvent(event: TaskEvent, activeGeneration: number) {
    if (activeGeneration !== generation) return;
    if (event.type === "TaskAdded") {
      const task = normalizeTaskRow(event.task);
      if (!task?.runConfigId) return;
      taskConfigIds.set(task.id, task.runConfigId);
      const index = items.value.findIndex((config) => config.id === task.runConfigId);
      // 不在列表里的配置可能因「最近结果」过滤被排除，换了最后一次任务后可能该进来：拉整行交给 matches 判定
      if (index === -1) {
        await refetchInto(task.runConfigId, activeGeneration);
        return;
      }
      const lastTask = lastTaskFromCrawlTask(task);
      if (!lastTask) return;
      const current = items.value[index];
      const previous = current.lastTask;
      if (
        previous &&
        (previous.startTime > lastTask.startTime ||
          (previous.startTime === lastTask.startTime && previous.id > lastTask.id))
      )
        return;
      upsert({ ...current, lastTask, lastResult: lastResultOf(lastTask) }, true);
      return;
    }
    const index = items.value.findIndex((config) => config.lastTask?.id === event.taskId);
    if (index === -1) {
      // 本页开着期间新增的任务记过所属配置；状态变化可能让被过滤掉的配置重新符合条件
      const configId = taskConfigIds.get(event.taskId);
      if (event.type === "TaskDeleted") taskConfigIds.delete(event.taskId);
      if (configId && (event.type === "TaskDeleted" || event.diff.status != null)) {
        await refetchInto(configId, activeGeneration);
      }
      return;
    }
    const current = items.value[index];
    if (event.type === "TaskDeleted") {
      const refreshed = await fetchRunConfig(current.id);
      if (activeGeneration === generation && refreshed) upsert(refreshed, true);
      return;
    }
    const lastTask = { ...current.lastTask!, ...event.diff };
    upsert({ ...current, lastTask, lastResult: lastResultOf(lastTask) }, true);
  }

  async function start() {
    unsubscribeConfig?.();
    unsubscribeTasks?.();
    const activeGeneration = ++generation;
    const configBuffer: RunConfigEvent[] = [];
    const taskBuffer: TaskEvent[] = [];
    let ready = false;
    page = 1;
    startLoading();
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    unsubscribeConfig = subscribeRunConfigEvents((event) =>
      ready ? void applyConfigEvent(event, activeGeneration) : configBuffer.push(event),
    );
    unsubscribeTasks = subscribeTaskEvents((event) =>
      ready ? void applyTaskEvent(event, activeGeneration) : taskBuffer.push(event),
    );
    try {
      const [firstPage, count] = await Promise.all([
        fetchRunConfigPage(options.basePath(), 1),
        fetchRunConfigTotal(options.countPath()),
      ]);
      if (activeGeneration !== generation) return;
      items.value = firstPage;
      total.value = count;
      hasMore.value = firstPage.length === RUN_CONFIG_PAGE_SIZE && firstPage.length < count;
      ready = true;
      for (const event of configBuffer) await applyConfigEvent(event, activeGeneration);
      for (const event of taskBuffer) await applyTaskEvent(event, activeGeneration);
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  async function loadMore() {
    if (loading.value || !hasMore.value) return;
    const activeGeneration = generation;
    const nextPage = page + 1;
    startLoading();
    try {
      const rows = await fetchRunConfigPage(options.basePath(), nextPage);
      if (activeGeneration !== generation) return;
      page = nextPage;
      const known = new Set(items.value.map((config) => config.id));
      items.value = [...items.value, ...rows.filter((config) => !known.has(config.id))].sort(comparator());
      hasMore.value = rows.length === RUN_CONFIG_PAGE_SIZE && items.value.length < total.value;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  function stop() {
    generation++;
    unsubscribeConfig?.();
    unsubscribeTasks?.();
    unsubscribeConfig = null;
    unsubscribeTasks = null;
    if (countTimer) clearTimeout(countTimer);
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    finishLoading();
  }

  onScopeDispose(stop);
  return { items, total, loading, showLoading, hasMore, start, loadMore, stop, upsert, remove };
}
