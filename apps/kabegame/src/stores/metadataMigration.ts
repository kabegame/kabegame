import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface MetadataMigrationTask {
  pluginId: string;
  total: number;
  processed: number;
  startedAtMs: number;
}

export interface MetadataMigrationFinished {
  pluginId: string;
  total: number;
  processed: number;
  error: string | null;
}

export const useMetadataMigrationStore = defineStore("metadataMigration", () => {
  const tasks = ref<Map<string, MetadataMigrationTask>>(new Map());
  const lastError = ref<string | null>(null);
  const runningCount = computed(() => tasks.value.size);

  function applyRunState(snapshot: MetadataMigrationTask[]) {
    const previous = tasks.value;
    tasks.value = new Map(
      (Array.isArray(snapshot) ? snapshot : []).map((task) => [
        task.pluginId,
        // 延迟显示用前端首次看到的本地时间计时：后端时间戳在 web 模式下可能与浏览器时钟不一致
        { ...task, startedAtMs: previous.get(task.pluginId)?.startedAtMs ?? Date.now() },
      ]),
    );
  }

  function applyFinished(payload: MetadataMigrationFinished) {
    const next = new Map(tasks.value);
    next.delete(payload.pluginId);
    tasks.value = next;
    lastError.value = payload.error || null;
  }

  function clearError() {
    lastError.value = null;
  }

  return { tasks, lastError, runningCount, applyRunState, applyFinished, clearError };
});
