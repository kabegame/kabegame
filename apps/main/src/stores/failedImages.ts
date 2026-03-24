import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TaskFailedImage } from "@kabegame/core/types/image";

type FailedImagesChangePayload = {
  reason?: "added" | "removed" | "updated";
  taskId?: string;
  failedImageIds?: number[];
  failedImages?: TaskFailedImage[] | null;
  failedImage?: TaskFailedImage | null;
};

export const useFailedImagesStore = defineStore("failedImages", () => {
  const allFailed = ref<TaskFailedImage[]>([]);
  const loading = ref(false);

  let listenersInited = false;
  let unlistenFailedImagesChange: UnlistenFn | null = null;

  const failedCount = computed(() => allFailed.value.length);

  const loadAll = async () => {
    loading.value = true;
    try {
      const rows = await invoke<TaskFailedImage[]>("get_all_failed_images");
      allFailed.value = Array.isArray(rows) ? rows : [];
    } finally {
      loading.value = false;
    }
  };

  const applyFailedImagesChange = (payload: FailedImagesChangePayload) => {
    const reason = payload.reason;
    const failedImageIds = Array.isArray(payload.failedImageIds)
      ? payload.failedImageIds.map((id) => Number(id)).filter((id) => id > 0)
      : [];
    const failedImageId = failedImageIds[0] ?? 0;
    const failedImages = Array.isArray(payload.failedImages) ? payload.failedImages : [];
    const failedImage = payload.failedImage ?? null;

    if (reason === "added" && failedImages.length > 0) {
      for (const row of failedImages) {
        const existsIndex = allFailed.value.findIndex((item) => item.id === row.id);
        if (existsIndex >= 0) {
          allFailed.value.splice(existsIndex, 1, row);
        } else {
          allFailed.value.unshift(row);
        }
      }
      return;
    }

    if (reason === "removed" && failedImageIds.length > 0) {
      const idSet = new Set(failedImageIds);
      allFailed.value = allFailed.value.filter((item) => !idSet.has(item.id));
      return;
    }

    if (reason === "updated" && failedImageId > 0 && failedImage) {
      const idx = allFailed.value.findIndex((item) => item.id === failedImageId);
      if (idx >= 0) {
        allFailed.value.splice(idx, 1, failedImage);
      } else {
        // 防御性兜底：如果本地不存在该 id，则补进列表并保持 id DESC。
        allFailed.value.unshift(failedImage);
      }
      return;
    }

    void loadAll();
  };

  const initListeners = async () => {
    if (listenersInited) return;
    listenersInited = true;
    await loadAll();
    unlistenFailedImagesChange = await listen<FailedImagesChangePayload>(
      "failed-images-change",
      (event) => {
        applyFailedImagesChange(event.payload ?? {});
      }
    );
  };

  const retryFailed = async (failedId: number) => {
    await invoke("retry_task_failed_image", { failedId });
  };

  const deleteFailed = async (failedId: number) => {
    await invoke("delete_task_failed_image", { failedId });
  };

  const retryMany = async (ids: number[]) => {
    if (!ids.length) return [] as number[];
    return await invoke<number[]>("retry_failed_images", { ids });
  };

  const cancelRetry = async (failedId: number) => {
    await invoke("cancel_retry_failed_image", { failedId });
  };

  const cancelRetryMany = async (ids: number[]) => {
    if (!ids.length) return;
    await invoke("cancel_retry_failed_images", { ids });
  };

  const deleteMany = async (ids: number[]) => {
    if (!ids.length) return;
    await invoke("delete_failed_images", { ids });
  };

  const byTaskId = (taskId: string) =>
    allFailed.value.filter((item) => item.taskId === taskId);

  return {
    allFailed,
    failedCount,
    loading,
    loadAll,
    initListeners,
    retryFailed,
    retryMany,
    cancelRetry,
    cancelRetryMany,
    deleteMany,
    deleteFailed,
    byTaskId,
    unlistenFailedImagesChange,
  };
});
