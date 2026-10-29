import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 后台回填作业（`get_busy_tasks_snapshot().backfills`）；`running=false` 表示排队中。 */
export interface BackfillTask {
  id: string;
  processed: number;
  total: number | null;
  running: boolean;
  /** 前端首次看到的本地时间，仅用于排序与延迟显示。 */
  startedAtMs: number;
}

export interface BackfillFinished {
  id: string;
  processed: number;
  total: number | null;
  error: string | null;
}

export const useBackfillStore = defineStore("backfill", () => {
  const tasks = ref<Map<string, BackfillTask>>(new Map());
  const lastError = ref<string | null>(null);
  const runningCount = computed(() => tasks.value.size);

  function applyRunState(snapshot: Omit<BackfillTask, "startedAtMs">[]) {
    const previous = tasks.value;
    tasks.value = new Map(
      (Array.isArray(snapshot) ? snapshot : []).map((task) => [
        task.id,
        { ...task, startedAtMs: previous.get(task.id)?.startedAtMs ?? Date.now() },
      ]),
    );
  }

  function applyFinished(payload: BackfillFinished) {
    const next = new Map(tasks.value);
    next.delete(payload.id);
    tasks.value = next;
    lastError.value = payload.error || null;
  }

  function clearError() {
    lastError.value = null;
  }

  return { tasks, lastError, runningCount, applyRunState, applyFinished, clearError };
});
