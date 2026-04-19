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
import type { AlbumTreeNode } from "@kabegame/core/types/album";
import { buildAlbumTreeFromFlat } from "@kabegame/core/utils/albumTree";

export type { AlbumTreeNode };

/** 隐藏画册的固定 UUID（与后端 `HIDDEN_ALBUM_ID` 常量一致） */
export const HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000";

export interface Album {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

function parseParentId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

function normalizeAlbumRow(a: Record<string, unknown>): Album {
  const createdAt =
    (a.created_at as number | undefined) ??
    (a.createdAt as number | undefined) ??
    0;
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    parentId: parseParentId(a.parent_id ?? a.parentId),
    createdAt: typeof createdAt === "number" ? createdAt : Number(createdAt) || 0,
  };
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
  let unlistenAlbumChanged: UnlistenFn | null = null;
  let unlistenImagesChange: UnlistenFn | null = null;
  let reloadCountsTimer: number | null = null;

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

  const getChildren = (albumId: string): Album[] =>
    albums.value.filter((a) => a.parentId === albumId);

  const getDescendantIds = (albumId: string): string[] => {
    const out: string[] = [];
    const walk = (id: string) => {
      for (const a of albums.value) {
        if (a.parentId === id) {
          out.push(a.id);
          walk(a.id);
        }
      }
    };
    walk(albumId);
    return out;
  };

  const albumTree = computed((): AlbumTreeNode[] => buildAlbumTreeFromFlat(albums.value));

  /** 排除若干画册（及不需要单独处理：仅从扁平列表过滤后再建树） */
  const getAlbumTreeExcluding = (excludeIds: string[]): AlbumTreeNode[] => {
    const exclude = new Set(excludeIds);
    return buildAlbumTreeFromFlat(albums.value.filter((a) => !exclude.has(a.id)));
  };

  /** 画册列表页仅展示根画册（无 parent），并隐藏"隐藏画册"本体（通过独立入口访问） */
  const albumRoots = computed(() =>
    albums.value.filter((a) => a.parentId == null && a.id !== HIDDEN_ALBUM_ID),
  );

  const applyAlbumAddedPayload = (p: Record<string, unknown>) => {
    const row = normalizeAlbumRow(p);
    if (!row.id) return;
    if (albums.value.some((a) => a.id === row.id)) return;
    albums.value.unshift(row);
    if (albumCounts.value[row.id] == null) {
      albumCounts.value[row.id] = 0;
    }
  };

  const applyAlbumDeletedPayload = (albumId: string) => {
    const desc = getDescendantIds(albumId);
    const removeIds = new Set<string>([albumId, ...desc]);
    albums.value = albums.value.filter((a) => !removeIds.has(a.id));
    for (const id of removeIds) {
      delete albumImages.value[id];
      delete albumPreviews.value[id];
      delete albumCounts.value[id];
    }
    scheduleReloadAlbumCounts();
  };

  const applyAlbumChangedPayload = (
    albumId: string,
    changes: Record<string, unknown>,
  ) => {
    const album = albums.value.find((a) => a.id === albumId);
    if (!album) return;
    if (typeof changes.name === "string") {
      album.name = changes.name;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "parentId")) {
      const raw = changes.parentId;
      if (raw === null || raw === undefined) {
        album.parentId = null;
      } else {
        const s = String(raw).trim();
        album.parentId = s ? s : null;
      }
    }
  };

  const initEventListeners = async () => {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenAlbumAdded = await listen<Record<string, unknown>>("album-added", (event) => {
        const p = (event.payload ?? {}) as Record<string, unknown>;
        applyAlbumAddedPayload(p);
      });
      unlistenAlbumDeleted = await listen<{ albumId?: string }>("album-deleted", (event) => {
        const id = String((event.payload as { albumId?: string })?.albumId ?? "").trim();
        if (!id) return;
        applyAlbumDeletedPayload(id);
      });
      unlistenAlbumChanged = await listen<{
        albumId?: string;
        changes?: Record<string, unknown>;
      }>("album-changed", (event) => {
        const p = (event.payload ?? {}) as {
          albumId?: string;
          changes?: Record<string, unknown>;
        };
        const id = String(p.albumId ?? "").trim();
        const ch = p.changes;
        if (!id || !ch || typeof ch !== "object") return;
        applyAlbumChangedPayload(id, ch as Record<string, unknown>);
      });
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
      const rows = (Array.isArray(res) ? res : []).map((a) =>
        normalizeAlbumRow(a as unknown as Record<string, unknown>),
      );
      albums.value = rows.sort((a, b) => b.createdAt - a.createdAt);
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

  const createAlbum = async (
    name: string,
    opts: { reload?: boolean; parentId?: string | null } = {},
  ) => {
    await initEventListeners();
    try {
      const parentId = opts.parentId ?? undefined;
      const created = await invoke<Album>("add_album", {
        name,
        parentId: parentId ?? null,
      });

      const reload = opts.reload ?? true;
      if (reload) {
        await loadAlbums();
      } else {
        const row = normalizeAlbumRow(created as unknown as Record<string, unknown>);
        if (!albums.value.some((a) => a.id === row.id)) {
          albums.value.unshift(row);
        }
        if (albumCounts.value[row.id] == null) {
          albumCounts.value[row.id] = 0;
        }
      }
      return created;
    } catch (error: any) {
      const errorMessage =
        typeof error === "string" ? error : error?.message || String(error);
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
    applyAlbumDeletedPayload(albumId);
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
      const errorMessage =
        typeof error === "string" ? error : error?.message || String(error);
      throw new Error(errorMessage);
    }
  };

  const moveAlbum = async (albumId: string, newParentId: string | null) => {
    await initEventListeners();
    try {
      await invoke("move_album", { albumId, newParentId });
      const album = albums.value.find((a) => a.id === albumId);
      if (album) {
        album.parentId = newParentId;
      }
    } catch (error: any) {
      const errorMessage =
        typeof error === "string" ? error : error?.message || String(error);
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
    albumRoots,
    albumTree,
    albumImages,
    albumPreviews,
    albumCounts,
    loading,
    FAVORITE_ALBUM_ID,
    HIDDEN_ALBUM_ID,
    loadAlbums,
    getChildren,
    getDescendantIds,
    getAlbumTreeExcluding,
    createAlbum,
    deleteAlbum,
    renameAlbum,
    moveAlbum,
    addImagesToAlbum,
    addTaskImagesToAlbum,
    removeImagesFromAlbum,
    loadAlbumPreview,
    getAlbumImageIds,
  };
});
