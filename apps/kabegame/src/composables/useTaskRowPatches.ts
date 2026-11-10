import { onScopeDispose, type Ref, type ShallowRef } from "vue";
import { normalizeTaskEvent } from "@/services/tasks";
import { fetchRunConfig } from "@/services/runConfigs";
import { kbEvent$, type AutoConfigChangePayload } from "@/services/kbEvents";
import type { CrawlTask } from "@/stores/crawler";

/**
 * 已持有任务行的就地补丁：`TaskChanged` 的 diff 直接合并（只有进度的变化做 100ms 节流、只增不减），
 * 运行配置改名 / 删除时补关联配置名。只改手里的行、不发请求；行的增删由调用方的观察方刷新。
 */
export function useTaskRowPatches(items: ShallowRef<CrawlTask[]>, active: Ref<boolean>) {
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

  /** 换一批行（重新开始观察）时清掉进度节流记录。 */
  function reset() {
    lastProgressUpdateAt.clear();
  }

  onScopeDispose(() => {
    reset();
    taskPatches.unsubscribe();
    configPatches.unsubscribe();
  });

  return { patch, reset };
}
