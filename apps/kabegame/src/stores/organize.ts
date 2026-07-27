import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 与 OrganizeDialog 的 confirm 载荷 / 后端 start_organize 参数一致 */
export interface OrganizeOptions {
  dedupe: boolean;
  /** 去重保留策略：true 保留最新，false 保留最旧 */
  dedupeKeepNew: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  /** 为旧库媒体补充生成浏览器兼容副本（仅桌面） */
  regenCompatible: boolean;
  /** 为缺失或版本过旧的 JPEG/PNG/WebP/GIF 补充原生元数据 */
  backfillNativeMetadata: boolean;
  deleteSourceFiles: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
}

/** 与后端 `organize-progress` 事件字段一致。 */
export interface OrganizeProgress {
  processedGlobal: number;
  libraryTotal: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  removed: number;
  regenerated: number;
  backfilled: number;
}

/** 与后端 `get_organize_run_state` 返回值一致。 */
export interface OrganizeRunState extends OrganizeProgress, OrganizeOptions {
  running: boolean;
}

/** 与后端 `organize-finished` 事件字段一致。 */
export interface OrganizeFinished {
  removed: number;
  regenerated: number;
  backfilled: number;
  canceled: boolean;
  error: string | null;
}

const emptyProgress = (): OrganizeProgress => ({
  processedGlobal: 0,
  libraryTotal: 0,
  rangeStart: null,
  rangeEnd: null,
  removed: 0,
  regenerated: 0,
  backfilled: 0,
});

/** 整理任务的前端镜像；后端运行态通过 service hydrate 与事件持续同步。 */
export const useOrganizeStore = defineStore("organize", () => {
  const dialogOpen = ref(false);
  const running = ref(false);
  const progress = ref<OrganizeProgress>(emptyProgress());
  const lastRunOptions = ref<OrganizeOptions | null>(null);
  const startedAtMs = ref<number | null>(null);
  const lastError = ref<string | null>(null);

  const openDialog = () => {
    dialogOpen.value = true;
  };
  const closeDialog = () => {
    dialogOpen.value = false;
  };

  /** 区间模式沿用旧进度面板算法：分母为所选终点；全量模式分母为全库数量。 */
  const progressPercentage = computed(() => {
    const p = progress.value;
    if (p.rangeStart != null && p.rangeEnd != null && p.rangeEnd > p.rangeStart) {
      const current = Math.min(Math.max(p.processedGlobal, p.rangeStart), p.rangeEnd);
      return Math.max(0, Math.min(100, Math.round((current / p.rangeEnd) * 100)));
    }
    if (p.libraryTotal <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((p.processedGlobal / p.libraryTotal) * 100)));
  });

  function applyProgress(payload: Partial<OrganizeProgress> & { processed?: number; total?: number }) {
    if (!running.value) {
      running.value = true;
      startedAtMs.value ??= Date.now();
    }
    const current = progress.value;
    progress.value = {
      processedGlobal: payload.processedGlobal ?? payload.processed ?? current.processedGlobal,
      libraryTotal: payload.libraryTotal ?? payload.total ?? current.libraryTotal,
      rangeStart: payload.rangeStart === undefined ? current.rangeStart : payload.rangeStart,
      rangeEnd: payload.rangeEnd === undefined ? current.rangeEnd : payload.rangeEnd,
      removed: payload.removed ?? current.removed,
      regenerated: payload.regenerated ?? current.regenerated,
      backfilled: payload.backfilled ?? current.backfilled,
    };
  }

  function applyFinished(payload: OrganizeFinished) {
    progress.value = {
      ...progress.value,
      removed: payload.removed ?? progress.value.removed,
      regenerated: payload.regenerated ?? progress.value.regenerated,
      backfilled: payload.backfilled ?? progress.value.backfilled,
    };
    running.value = false;
    startedAtMs.value = null;
    lastRunOptions.value = null;
    lastError.value = payload.error || null;
  }

  function applyRunState(state: OrganizeRunState) {
    const wasRunning = running.value;
    running.value = !!state.running;
    progress.value = {
      processedGlobal: state.processedGlobal ?? 0,
      libraryTotal: state.libraryTotal ?? 0,
      rangeStart: state.rangeStart ?? null,
      rangeEnd: state.rangeEnd ?? null,
      removed: state.removed ?? 0,
      regenerated: state.regenerated ?? 0,
      backfilled: state.backfilled ?? 0,
    };
    if (state.running) {
      startedAtMs.value = wasRunning ? startedAtMs.value : Date.now();
      lastRunOptions.value = {
        dedupe: state.dedupe,
        dedupeKeepNew: state.dedupeKeepNew,
        removeMissing: state.removeMissing,
        removeUnrecognized: state.removeUnrecognized,
        regenThumbnails: state.regenThumbnails,
        regenCompatible: state.regenCompatible,
        backfillNativeMetadata: state.backfillNativeMetadata,
        deleteSourceFiles: state.deleteSourceFiles,
        rangeStart: state.rangeStart ?? null,
        rangeEnd: state.rangeEnd ?? null,
      };
    } else {
      startedAtMs.value = null;
      lastRunOptions.value = null;
    }
  }

  function begin(options: OrganizeOptions) {
    running.value = true;
    progress.value = emptyProgress();
    lastRunOptions.value = { ...options };
    startedAtMs.value = Date.now();
    lastError.value = null;
  }

  function clearError() {
    lastError.value = null;
  }

  return {
    dialogOpen,
    running,
    progress,
    lastRunOptions,
    startedAtMs,
    lastError,
    progressPercentage,
    openDialog,
    closeDialog,
    applyProgress,
    applyFinished,
    applyRunState,
    begin,
    clearError,
  };
});
