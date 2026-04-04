import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";

export interface Album {
  id: string;
  name: string;
  createdAt: number;
}

export const useAlbumStore = defineStore("albums", () => {
  const settingsStore = useSettingsStore();
  const FAVORITE_ALBUM_ID = computed(() => settingsStore.favoriteAlbumId);

  const albums = ref<Album[]>([]);
  const albumImages = ref<Record<string, ImageInfo[]>>({});
  const albumPreviews = ref<Record<string, ImageInfo[]>>({});
  const albumCounts = ref<Record<string, number>>({});
  const loading = ref(false);

  let eventListenersInitialized = false;
  let unlistenAlbumAdded: UnlistenFn | null = null;
  let unlistenAlbumDeleted: UnlistenFn | null = null;
  let unlistenAlbumNameChanged: UnlistenFn | null = null;
  let unlistenImagesChange: UnlistenFn | null = null;
  let reloadCountsTimer: number | null = null;

  const onAlbumsListChanged = async () => {
    await loadAlbums();
  };

  const scheduleReloadAlbumCounts = () => {
    if (reloadCountsTimer !== null) {
      clearTimeout(reloadCountsTimer);
    }
    reloadCountsTimer = window.setTimeout(async () => {
      reloadCountsTimer = null;
      try {
        const counts = await invoke<Record<string, number>>("get_album_counts");
        albumCounts.value = counts;
      } catch (e) {
        console.warn("reload album counts failed", e);
      }
    }, 250);
  };

  const initEventListeners = async () => {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenAlbumAdded = await listen("album-added", onAlbumsListChanged);
      unlistenAlbumDeleted = await listen("album-deleted", onAlbumsListChanged);
      unlistenAlbumNameChanged = await listen("album-name-changed", onAlbumsListChanged);
      // `images` 表变更：无画册维度字段，保守失效全部画册图片缓存
      unlistenImagesChange = await listen<ImagesChangePayload>("images-change", async () => {
        albumImages.value = {};
        albumPreviews.value = {};
        scheduleReloadAlbumCounts();
      });
      // `album_images` 表变更：按 albumIds 精准失效
      await listen<AlbumImagesChangePayload>(
        "album-images-change",
        async (event) => {
          const p = (event.payload ?? {}) as AlbumImagesChangePayload;
          const ids = (p.albumIds ?? []).map((x) => String(x).trim()).filter(Boolean);
          if (ids.length === 0) {
            albumImages.value = {};
            albumPreviews.value = {};
          } else {
            for (const aid of ids) {
              delete albumImages.value[aid];
              delete albumPreviews.value[aid];
            }
          }
          scheduleReloadAlbumCounts();
        }
      );
    } catch (e) {
      console.warn("init album event listeners failed", e);
    }
  };

  const loadAlbums = async () => {
    await initEventListeners();
    loading.value = true;
    try {
      const res = await invoke<Album[]>("get_albums");
      // 后端字段为 camelCase，按创建时间倒序（新→旧）
      albums.value = res
        .map((a) => ({
          ...a,
          createdAt: (a as any).created_at ?? (a as any).createdAt ?? a.createdAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      // 同步加载数量（非阻塞）
      try {
        const counts = await invoke<Record<string, number>>("get_album_counts");
        albumCounts.value = counts;
      } catch (e) {
        console.warn("load album counts failed", e);
      }
    } finally {
      loading.value = false;
    }
  };

  const createAlbum = async (name: string, opts: { reload?: boolean } = {}) => {
    await initEventListeners();
    try {
      const created = await invoke<Album>("add_album", { name });

      const reload = opts.reload ?? true;
      if (reload) {
        // 创建成功后重新从后端加载画册列表，保持前后端数据一致
        await loadAlbums();
      } else {
        // 轻量模式：避免在批量导入时反复全量 reload 造成 UI 卡顿
        const createdAt =
          (created as any).created_at ??
          (created as any).createdAt ??
          created.createdAt;
        // 避免重复插入
        if (!albums.value.some((a) => a.id === created.id)) {
          albums.value.unshift({ ...created, createdAt });
        }
        // counts 先按 0 兜底；后续可由 loadAlbums/get_album_counts 纠正
        if (albumCounts.value[created.id] == null) {
          albumCounts.value[created.id] = 0;
        }
      }
      return created;
    } catch (error: any) {
      // 确保错误信息被正确传递
      const errorMessage = typeof error === "string" 
        ? error 
        : error?.message || String(error);
      throw new Error(errorMessage);
    }
  };

  const deleteAlbum = async (albumId: string) => {
    await initEventListeners();
    if (settingsStore.values.wallpaperRotationAlbumId == albumId) {
      await ElMessageBox.confirm(
        i18n.global.t("albums.deleteAlbumRotationConfirm"),
        i18n.global.t("albums.deleteAlbumRotationTitle"),
        {
          type: "warning",
          dangerouslyUseHTMLString: true,
          confirmButtonText: i18n.global.t("common.ok"),
          cancelButtonText: i18n.global.t("common.cancel"),
        },
      );
    }
    await invoke("delete_album", { albumId });
    albums.value = albums.value.filter((a) => a.id !== albumId);
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    delete albumCounts.value[albumId];
  };

  const renameAlbum = async (albumId: string, newName: string) => {
    await initEventListeners();
    try {
      await invoke("rename_album", { albumId, newName });
      const album = albums.value.find((a) => a.id === albumId);
      if (album) {
        album.name = newName;
      }
    } catch (error: any) {
      // 确保错误信息被正确传递
      const errorMessage = typeof error === "string" 
        ? error 
        : error?.message || String(error);
      throw new Error(errorMessage);
    }
  };

  const addImagesToAlbum = async (albumId: string, imageIds: string[]) => {
    await initEventListeners();
    try {
      const result = await invoke<{
        added: number;
        attempted: number;
        canAdd: number;
        currentCount: number;
      }>("add_images_to_album", { albumId, imageIds });

      // 清除缓存，下一次自动刷新
      delete albumImages.value[albumId];
      delete albumPreviews.value[albumId];
      // 更新计数（使用后端返回的实际数量）
      albumCounts.value[albumId] = result.currentCount;

    } catch (error: any) {
      throw error;
    }
  };

  /** 将任务的全部图片加入画册（后端根据 taskId 取图） */
  const addTaskImagesToAlbum = async (taskId: string, albumId: string) => {
    await initEventListeners();
    const result = await invoke<{
      added: number;
      attempted: number;
      canAdd: number;
      currentCount: number;
    }>("add_task_images_to_album", { taskId, albumId });
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    albumCounts.value[albumId] = result.currentCount;
    return result;
  };

  const removeImagesFromAlbum = async (albumId: string, imageIds: string[]) => {
    await initEventListeners();
    if (!imageIds || imageIds.length === 0) return 0;
    const removed = await invoke<number>("remove_images_from_album", {
      albumId,
      imageIds,
    });
    // 清除缓存，下一次自动刷新
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    // 更新计数（本地 - removed，兜底不小于 0）
    const prev = albumCounts.value[albumId] || 0;
    albumCounts.value[albumId] = Math.max(0, prev - removed);

    return removed;
  };

  const loadAlbumImages = async (albumId: string) => {
    await initEventListeners();
    const images = await invoke<ImageInfo[]>("get_album_images", { albumId });
    albumImages.value[albumId] = images;
    return images;
  };

  const loadAlbumPreview = async (albumId: string, limit = 6) => {
    await initEventListeners();
    if (albumPreviews.value[albumId]) return albumPreviews.value[albumId];
    const images = await invoke<ImageInfo[]>("get_album_preview", {
      albumId,
      limit,
    });
    albumPreviews.value[albumId] = images;
    return images;
  };

  const getAlbumImageIds = async (albumId: string): Promise<string[]> => {
    await initEventListeners();
    return await invoke<string[]>("get_album_image_ids", { albumId });
  };

  return {
    albums,
    albumImages,
    albumPreviews,
    albumCounts,
    loading,
    FAVORITE_ALBUM_ID,
    loadAlbums,
    createAlbum,
    deleteAlbum,
    renameAlbum,
    addImagesToAlbum,
    addTaskImagesToAlbum,
    removeImagesFromAlbum,
    loadAlbumImages,
    loadAlbumPreview,
    getAlbumImageIds,
  };
});
