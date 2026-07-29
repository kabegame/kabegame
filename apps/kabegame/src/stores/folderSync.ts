import { defineStore } from "pinia";
import { computed, ref } from "vue";

/** 与 `folder-sync-progress` 及运行态快照中的单个任务字段一致。 */
export interface FolderSyncTask {
  albumId: string;
  albumName: string;
  recursive: boolean;
  added: number;
  deleted: number;
  reimported: number;
  createdAlbums: number;
  startedAtMs: number;
}

/** `folder-sync-finished` 不再携带 startedAtMs。 */
export type FolderSyncFinished = Omit<FolderSyncTask, "startedAtMs"> & {
  /** 用户主动取消（不是失败）：与 error 互斥。 */
  canceled: boolean;
  error: string | null;
};

export interface FolderSyncRunState {
  tasks: FolderSyncTask[];
}

export const useFolderSyncStore = defineStore("folderSync", () => {
  const tasks = ref<Map<string, FolderSyncTask>>(new Map());
  const lastError = ref<string | null>(null);
  const runningCount = computed(() => tasks.value.size);

  function applyProgress(task: FolderSyncTask) {
    const next = new Map(tasks.value);
    next.set(task.albumId, { ...task });
    tasks.value = next;
  }

  function applyFinished(payload: FolderSyncFinished) {
    const next = new Map(tasks.value);
    next.delete(payload.albumId);
    tasks.value = next;
    lastError.value = payload.error || null;
  }

  function applyRunState(state: FolderSyncRunState) {
    tasks.value = new Map(
      (Array.isArray(state.tasks) ? state.tasks : []).map((task) => [task.albumId, { ...task }]),
    );
  }

  function clearError() {
    lastError.value = null;
  }

  return {
    tasks,
    lastError,
    runningCount,
    applyProgress,
    applyFinished,
    applyRunState,
    clearError,
  };
});
