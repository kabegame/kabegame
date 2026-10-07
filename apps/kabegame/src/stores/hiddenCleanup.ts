import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 隐藏清理运行态快照中的进度字段。 */
export interface HiddenCleanupProgress {
  processed: number;
  total: number;
  removed: number;
  /** DB 记录已删、但源文件仍留在磁盘/相册的条数（回收站护栏拦下、Android 未授权等） */
  keptFiles: number;
}

/** 与后端聚合忙碌任务快照中的隐藏清理字段一致。 */
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

/** 清理隐藏图片任务的前端镜像；后端运行态通过快照轮询同步。 */
export const useHiddenCleanupStore = defineStore("hiddenCleanup", () => {
  const running = ref(false);
  const progress = ref<HiddenCleanupProgress>(emptyProgress());
  const startedAtMs = ref<number | null>(null);
  const lastError = ref<string | null>(null);
  const starting = ref(false);

  const progressPercentage = computed(() => {
    const p = progress.value;
    if (p.total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((p.processed / p.total) * 100)));
  });

  function applyFinished(payload: HiddenCleanupFinished) {
    if (!running.value) {
      lastError.value = payload.error || null;
      return;
    }
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
    if (!state.running && starting.value) return;
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
    starting.value = true;
    running.value = true;
    progress.value = { ...emptyProgress(), total };
    startedAtMs.value = Date.now();
    lastError.value = null;
  }

  function endStarting() {
    starting.value = false;
  }

  function clearError() {
    lastError.value = null;
  }

  return {
    running,
    progress,
    startedAtMs,
    lastError,
    starting,
    progressPercentage,
    applyFinished,
    applyRunState,
    begin,
    endStarting,
    clearError,
  };
});
