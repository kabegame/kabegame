import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 与后端 `hidden-cleanup-progress` 事件字段一致。 */
export interface HiddenCleanupProgress {
  processed: number;
  total: number;
  removed: number;
  /** DB 记录已删、但源文件仍留在磁盘/相册的条数（回收站护栏拦下、Android 未授权等） */
  keptFiles: number;
}

/** 与后端 `get_hidden_cleanup_run_state` 返回值一致。 */
export interface HiddenCleanupRunState extends HiddenCleanupProgress {
  running: boolean;
}

/** 与后端 `hidden-cleanup-finished` 事件字段一致。 */
export interface HiddenCleanupFinished {
  removed: number;
  keptFiles: number;
  canceled: boolean;
  error: string | null;
}

const emptyProgress = (): HiddenCleanupProgress => ({
  processed: 0,
  total: 0,
  removed: 0,
  keptFiles: 0,
});

/** 清理隐藏图片任务的前端镜像；后端运行态通过 service hydrate 与事件持续同步。 */
export const useHiddenCleanupStore = defineStore("hiddenCleanup", () => {
  const running = ref(false);
  const progress = ref<HiddenCleanupProgress>(emptyProgress());
  const startedAtMs = ref<number | null>(null);
  const lastError = ref<string | null>(null);

  const progressPercentage = computed(() => {
    const p = progress.value;
    if (p.total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)));
  });

  function applyProgress(payload: Partial<HiddenCleanupProgress>) {
    if (!running.value) {
      running.value = true;
      startedAtMs.value ??= Date.now();
    }
    const current = progress.value;
    progress.value = {
      processed: payload.processed ?? current.processed,
      total: payload.total ?? current.total,
      removed: payload.removed ?? current.removed,
      keptFiles: payload.keptFiles ?? current.keptFiles,
    };
  }

  function applyFinished(payload: HiddenCleanupFinished) {
    progress.value = {
      ...progress.value,
      removed: payload.removed ?? progress.value.removed,
      keptFiles: payload.keptFiles ?? progress.value.keptFiles,
    };
    running.value = false;
    startedAtMs.value = null;
    lastError.value = payload.error || null;
  }

  function applyRunState(state: HiddenCleanupRunState) {
    const wasRunning = running.value;
    running.value = !!state.running;
    progress.value = {
      processed: state.processed ?? 0,
      total: state.total ?? 0,
      removed: state.removed ?? 0,
      keptFiles: state.keptFiles ?? 0,
    };
    startedAtMs.value = state.running ? (wasRunning ? startedAtMs.value : Date.now()) : null;
  }

  function begin(total: number) {
    running.value = true;
    progress.value = { ...emptyProgress(), total };
    startedAtMs.value = Date.now();
    lastError.value = null;
  }

  function clearError() {
    lastError.value = null;
  }

  return {
    running,
    progress,
    startedAtMs,
    lastError,
    progressPercentage,
    applyProgress,
    applyFinished,
    applyRunState,
    begin,
    clearError,
  };
});
