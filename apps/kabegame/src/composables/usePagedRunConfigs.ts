import { pathqlCount, pathqlView } from "@/services/pathql";
import { useLiveQuery, type RowsSnapshot, type TotalSnapshot } from "@/services/liveQuery";
import { registerRunConfigView } from "@/services/runConfigWrites";
import { normalizeRunConfigRow } from "@/services/runConfigs";
import { onScopeDispose, ref, shallowRef } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import {
  compareRunConfigs,
  fetchRunConfig,
  lastResultOf,
  lastTaskFromCrawlTask,
  RUN_CONFIG_PAGE_SIZE,
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
  const page = ref(1);
  const active = ref(false);
  let unsubscribeTasks: (() => void) | null = null;
  let countTimer: ReturnType<typeof setTimeout> | null = null;

  function comparator() {
    const { key, dir } = options.sort();
    return compareRunConfigs(key, dir);
  }

  const rowsQuery = useLiveQuery<RowsSnapshot>({
    key: () => (active.value ? `run_configs://${options.basePath()}x${page.value * RUN_CONFIG_PAGE_SIZE}x/1` : null),
    read: pathqlView,
    waitMs: 200,
    relevant: (batch) => batch.runConfigs.size > 0,
    onResult: (snapshot) => {
      items.value = snapshot.rows.map(normalizeRunConfigRow).filter((config): config is RunConfig => config !== null);
      hasMore.value = items.value.length >= page.value * RUN_CONFIG_PAGE_SIZE && items.value.length < total.value;
    },
  });
  const totalQuery = useLiveQuery<TotalSnapshot>({
    key: () => (active.value ? `run_configs://${options.countPath().replace(/\/$/, "")}` : null),
    read: pathqlCount,
    waitMs: 200,
    relevant: (batch) => batch.runConfigs.size > 0,
    onResult: (snapshot) => {
      total.value = snapshot.total;
      hasMore.value = items.value.length >= page.value * RUN_CONFIG_PAGE_SIZE && items.value.length < total.value;
    },
  });
  const unregisterView = registerRunConfigView({ key: rowsQuery.key, apply: rowsQuery.apply });

  function scheduleCountRefresh() {
    if (countTimer) clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      countTimer = null;
      void totalQuery.refetch();
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
    unsubscribeTasks?.();
    const activeGeneration = ++generation;
    const taskBuffer: TaskEvent[] = [];
    let ready = false;
    page.value = 1;
    active.value = true;
    startLoading();
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    unsubscribeTasks = subscribeTaskEvents((event) =>
      ready ? void applyTaskEvent(event, activeGeneration) : taskBuffer.push(event),
    );
    try {
      await Promise.all([rowsQuery.refetch(), totalQuery.refetch()]);
      if (activeGeneration !== generation) return;
      ready = true;
      for (const event of taskBuffer) await applyTaskEvent(event, activeGeneration);
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  async function loadMore() {
    if (loading.value || !hasMore.value) return;
    const activeGeneration = generation;
    // 当前已加载的 N 页作为同一视图窗口，写操作才能按后端排序补齐窗口内的行。
    page.value++;
    startLoading();
    try {
      await rowsQuery.refetch();
    } catch (error) {
      if (activeGeneration === generation) page.value--;
      throw error;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  function stop() {
    generation++;
    active.value = false;
    unsubscribeTasks?.();
    unsubscribeTasks = null;
    if (countTimer) clearTimeout(countTimer);
    items.value = [];
    total.value = 0;
    hasMore.value = false;
    finishLoading();
  }

  onScopeDispose(() => {
    stop();
    unregisterView();
  });
  return { items, total, loading, showLoading, hasMore, start, loadMore, stop };
}
