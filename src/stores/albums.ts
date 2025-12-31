import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageInfo } from "./crawler";
import { useSettingsStore } from "./settings";

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

  const loadAlbums = async () => {
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

  const createAlbum = async (name: string) => {
    const created = await invoke<Album>("add_album", { name });
    // 创建成功后重新从后端加载画册列表，保持前后端数据一致
    await loadAlbums();
    return created;
  };

  const deleteAlbum = async (albumId: string) => {
    await invoke("delete_album", { albumId });
    albums.value = albums.value.filter((a) => a.id !== albumId);
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    delete albumCounts.value[albumId];
  };

  const renameAlbum = async (albumId: string, newName: string) => {
    await invoke("rename_album", { albumId, newName });
    const album = albums.value.find((a) => a.id === albumId);
    if (album) {
      album.name = newName;
    }
  };

  const addImagesToAlbum = async (albumId: string, imageIds: string[]) => {
    await invoke<number>("add_images_to_album", { albumId, imageIds });
    // 清除缓存，下一次自动刷新
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    // 更新计数（本地 + n）
    const prev = albumCounts.value[albumId] || 0;
    albumCounts.value[albumId] = prev + imageIds.length;

    // 如果是收藏画册，通知画廊等页面更新收藏状态
    if (albumId === FAVORITE_ALBUM_ID.value) {
      window.dispatchEvent(
        new CustomEvent("favorite-status-changed", {
          detail: { imageIds, favorite: true },
        })
      );
    }
  };

  const removeImagesFromAlbum = async (albumId: string, imageIds: string[]) => {
    if (!imageIds || imageIds.length === 0) return 0;
    const removed = await invoke<number>("remove_images_from_album", { albumId, imageIds });
    // 清除缓存，下一次自动刷新
    delete albumImages.value[albumId];
    delete albumPreviews.value[albumId];
    // 更新计数（本地 - removed，兜底不小于 0）
    const prev = albumCounts.value[albumId] || 0;
    albumCounts.value[albumId] = Math.max(0, prev - removed);

    // 如果是收藏画册，通知画廊等页面更新收藏状态
    if (albumId === FAVORITE_ALBUM_ID.value) {
      window.dispatchEvent(
        new CustomEvent("favorite-status-changed", {
          detail: { imageIds, favorite: false },
        })
      );
    }
    return removed;
  };

  const loadAlbumImages = async (albumId: string) => {
    const images = await invoke<ImageInfo[]>("get_album_images", { albumId });
    albumImages.value[albumId] = images;
    return images;
  };

  const loadAlbumPreview = async (albumId: string, limit = 6) => {
    if (albumPreviews.value[albumId]) return albumPreviews.value[albumId];
    const images = await invoke<ImageInfo[]>("get_album_preview", {
      albumId,
      limit,
    });
    albumPreviews.value[albumId] = images;
    return images;
  };

  const getAlbumImageIds = async (albumId: string): Promise<string[]> => {
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
