import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "./crawler";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";

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
  let unlistenAlbumsChanged: UnlistenFn | null = null;
  let unlistenImagesChange: UnlistenFn | null = null;
  let reloadCountsTimer: number | null = null;

  const initEventListeners = async () => {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenAlbumsChanged = await listen("albums-changed", async () => {
        // 画册列表变化：直接 reload（包含 counts）
        await loadAlbums();
      });
      // 统一图片变更事件：作为“数据可能变化”的失效信号，只做缓存失效 + 计数刷新
      unlistenImagesChange = await listen<ImagesChangePayload>(
        "images-change",
        async (event) => {
          const p = (event.payload ?? {}) as ImagesChangePayload;
          const albumId = (p.albumId ?? "").trim();

          // 1) 缓存失效：带 albumId 则精准失效，否则保守失效全部
          if (albumId) {
            delete albumImages.value[albumId];
            delete albumPreviews.value[albumId];
          } else {
            albumImages.value = {};
            albumPreviews.value = {};
          }

          // 2) counts 可能变化：用轻量 debounce 合并 burst
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
      // 后端字段为 camelCase
      albums.value = res.map((a) => ({
        ...a,
        createdAt: (a as any).created_at ?? (a as any).createdAt ?? a.createdAt,
      }));
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

      // 如果是收藏画册，通知画廊等页面更新收藏状态
      if (albumId === FAVORITE_ALBUM_ID.value) {
        // 只更新实际添加的图片到 crawlerStore（不再使用全局事件）
        const addedImageIds = imageIds.slice(0, result.added);
        if (addedImageIds.length > 0) {
          crawlerStore.images = crawlerStore.images.map((img) =>
            addedImageIds.includes(img.id)
              ? ({ ...img, favorite: true } as ImageInfo)
              : img
          );
        }
      }
    } catch (error: any) {
      // 如果后端返回错误，尝试解析错误信息
      const errorMessage = error?.message || String(error);

      // 如果错误信息包含上限提示，需要获取详细信息
      if (errorMessage.includes("上限")) {
        const currentCount = albumCounts.value[albumId] || 0;
        const MAX_ALBUM_IMAGES = 10000;
        const canAdd = Math.max(0, MAX_ALBUM_IMAGES - currentCount);
        const attempted = imageIds.length;

        if (canAdd === 0) {
          throw new Error(`画册已满（${MAX_ALBUM_IMAGES} 张），无法继续添加`);
        } else {
          throw new Error(
            `画册空间不足：最多可放入 ${canAdd} 张，尝试放入 ${attempted} 张`
          );
        }
      }

      // 其他错误直接抛出
      throw error;
    }
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

    // 如果是收藏画册，通知画廊等页面更新收藏状态
    if (albumId === FAVORITE_ALBUM_ID.value) {
      crawlerStore.images = crawlerStore.images.map((img) =>
        imageIds.includes(img.id)
          ? ({ ...img, favorite: false } as ImageInfo)
          : img
      );
    }
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
    removeImagesFromAlbum,
    loadAlbumImages,
    loadAlbumPreview,
    getAlbumImageIds,
  };
});
