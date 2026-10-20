import { onScopeDispose, ref, shallowRef } from "vue";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import {
  fetchTask,
  fetchTaskPage,
  fetchTaskTotal,
  subscribeTaskEvents,
  TASK_PAGE_SIZE,
  type TaskEvent,
} from "@/services/tasks";
import { fetchRunConfig, subscribeRunConfigEvents, type RunConfigEvent } from "@/services/runConfigs";
import type { CrawlTask } from "@/stores/crawler";

export function usePagedTaskList(options: {
  basePath: () => string;
  matches: (task: CrawlTask) => boolean;
}) {
  const items = shallowRef<CrawlTask[]>([]);
  const total = ref(0);
  // 真实加载态 loading 只做并发守卫与空态判断；showLoading 超过延迟才为真，供 v-loading 转圈，避免快速返回时闪烁
  const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();
  const hasMore = ref(false);
  let generation = 0;
  let unsubscribeTasks: (() => void) | null = null;
  let unsubscribeConfigs: (() => void) | null = null;
  const lastProgressUpdateAt = new Map<string, number>();

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

  function remove(id: string) {
    const exists = items.value.some((task) => task.id === id);
    if (!exists) return false;
    items.value = items.value.filter((task) => task.id !== id);
    total.value = Math.max(0, total.value - 1);
    hasMore.value = items.value.length < total.value;
    return true;
  }

  async function applyTaskEvent(event: TaskEvent, activeGeneration: number) {
    if (activeGeneration !== generation) return;
    if (event.type === "TaskAdded") {
      const taskId = String(
        (event.task as Record<string, unknown> | null)?.id ??
          (event.task as Record<string, unknown> | null)?.taskId ??
          "",
      ).trim();
      if (!taskId) return;
      const task = await fetchTask(taskId);
      if (activeGeneration !== generation || !task || !options.matches(task)) return;
      const index = items.value.findIndex((item) => item.id === task.id);
      if (index === -1) {
        items.value = [task, ...items.value];
        total.value++;
      } else {
        replaceAt(index, { ...items.value[index], ...task });
      }
      hasMore.value = items.value.length < total.value;
      return;
    }
    if (event.type === "TaskDeleted") {
      remove(event.taskId);
      lastProgressUpdateAt.delete(event.taskId);
      return;
    }
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
  }

  async function applyConfigEvent(event: RunConfigEvent, activeGeneration: number) {
    if (activeGeneration !== generation) return;
    if (event.reason === "configdelete") {
      items.value = items.value.map((task) =>
        task.runConfigId === event.configId ? { ...task, runConfigName: null } : task,
      );
      return;
    }
    if (event.reason !== "configchange") return;
    const config = await fetchRunConfig(event.configId);
    if (activeGeneration !== generation) return;
    items.value = items.value.map((task) =>
      task.runConfigId === event.configId ? { ...task, runConfigName: config?.name ?? null } : task,
    );
  }

  function cleanupSubscriptions() {
    unsubscribeTasks?.();
    unsubscribeTasks = null;
    unsubscribeConfigs?.();
    unsubscribeConfigs = null;
  }

  async function start() {
    cleanupSubscriptions();
    const activeGeneration = ++generation;
    const buffered: TaskEvent[] = [];
    const bufferedConfigs: RunConfigEvent[] = [];
    let ready = false;
    startLoading();
    items.value = [];
    total.value = 0;
    hasMore.value = false;

    unsubscribeTasks = subscribeTaskEvents((event) => {
      if (!ready) buffered.push(event);
      else void applyTaskEvent(event, activeGeneration);
    });
    unsubscribeConfigs = subscribeRunConfigEvents((event) => {
      if (!ready) bufferedConfigs.push(event);
      else void applyConfigEvent(event, activeGeneration);
    });

    const base = options.basePath();
    try {
      const [page, count] = await Promise.all([fetchTaskPage(base), fetchTaskTotal(base)]);
      if (activeGeneration !== generation) return;
      items.value = page;
      total.value = count;
      ready = true;
      for (const event of buffered) await applyTaskEvent(event, activeGeneration);
      for (const event of bufferedConfigs) await applyConfigEvent(event, activeGeneration);
      hasMore.value = page.length === TASK_PAGE_SIZE && items.value.length < total.value;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  async function loadMore() {
    if (loading.value || !hasMore.value || items.value.length === 0) return;
    const activeGeneration = generation;
    startLoading();
    try {
      const page = await fetchTaskPage(options.basePath(), items.value.at(-1));
      if (activeGeneration !== generation) return;
      const known = new Set(items.value.map((task) => task.id));
      const appended = page.filter((task) => !known.has(task.id));
      items.value = [...items.value, ...appended];
      hasMore.value = page.length === TASK_PAGE_SIZE && items.value.length < total.value;
    } finally {
      if (activeGeneration === generation) finishLoading();
    }
  }

  function stop() {
    generation++;
    cleanupSubscriptions();
    items.value = [];
    total.value = 0;
    finishLoading();
    hasMore.value = false;
    lastProgressUpdateAt.clear();
  }

  onScopeDispose(stop);
  return { items, total, loading, showLoading, hasMore, start, loadMore, stop, patch, remove };
}
