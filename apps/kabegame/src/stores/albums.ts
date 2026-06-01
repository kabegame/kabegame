import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke, listen } from "@/api/rpc";
import { pathqlFetch } from "@/services/pathql";
import { rowToImageInfo } from "@/utils/imageRow";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import type { UnlistenFn } from "@/api/rpc";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import type { AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";
import type { AlbumTreeNode } from "@kabegame/core/types/album";
import { buildAlbumTreeFromFlat } from "@kabegame/core/utils/albumTree";
import {
  buildAlbumMediaNodes,
  fetchAlbumDirectCounts,
  type AlbumMediaNode,
} from "@/utils/albumMediaTree";

export type { AlbumTreeNode };

/** 隐藏画册的固定 UUID（与后端 `HIDDEN_ALBUM_ID` 常量一致） */
export const HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000";
/** 收藏画册的固定 UUID（与后端 `FAVORITE_ALBUM_ID` 常量一致） */
export const FAVORITE_ALBUM_ID = "00000000-0000-0000-0000-000000000001";

export type AlbumKind = "normal" | "local_folder";

export interface FolderStatus {
  state: "ok" | "missing" | "denied" | "not_a_dir" | "io_error";
  message?: string;
  checkedAt?: number;
  checked_at?: number;
  lastSyncedAtMs?: number;
  last_synced_at_ms?: number;
}

export interface Album {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  type: AlbumKind;
  syncFolder: string | null;
  folderStatus: FolderStatus | null;
}

export interface AlbumStats {
  directImageCount: number;
  imageCount: number;
  subAlbumCount: number;
}

type AlbumRow = Record<string, unknown>;

function parseParentId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === "null" || s === "undefined") return null;
  return s ? s : null;
}

function parseFolderStatus(raw: unknown): FolderStatus | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as FolderStatus;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? (parsed as FolderStatus) : null;
  } catch {
    return null;
  }
}

function normalizeAlbumRow(a: Record<string, unknown>): Album {
  const createdAt =
    (a.created_at as number | undefined) ??
    (a.createdAt as number | undefined) ??
    0;
  const rawType = String(a.type ?? "normal");
  const type: AlbumKind = rawType === "local_folder" ? "local_folder" : "normal";
  const syncFolder = ((): string | null => {
    const v = a.sync_folder ?? a.syncFolder;
    return v == null ? null : String(v);
  })();
  const folderStatus = ((): FolderStatus | null => {
    const raw = a.folder_status ?? a.folderStatus;
    return parseFolderStatus(raw);
  })();
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    parentId: parseParentId(a.parent_id ?? a.parentId),
    createdAt: typeof createdAt === "number" ? createdAt : Number(createdAt) || 0,
    type,
    syncFolder,
    folderStatus,
  };
}

function albumFromProviderRow(row: AlbumRow): Album | null {
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  return normalizeAlbumRow(row);
}

export const useAlbumStore = defineStore("albums", () => {
  const settingsStore = useSettingsStore();

  const albums = ref<Album[]>([]);
  const albumImages = ref<Record<string, ImageInfo[]>>({});
  const albumPreviews = ref<Record<string, ImageInfo[]>>({});
  const albumDirectCounts = ref<Record<string, number>>({});
  const albumHiddenDirectCounts = ref<Record<string, number>>({});
  const albumCounts = ref<Record<string, number>>({});
  const albumHiddenCounts = ref<Record<string, number>>({});
  const albumStats = ref<Record<string, AlbumStats>>({});
  const albumHiddenStats = ref<Record<string, AlbumStats>>({});
  const loading = ref(false);

  let eventListenersInitialized = false;
  let unlistenAlbumAdded: UnlistenFn | null = null;
  let unlistenAlbumDeleted: UnlistenFn | null = null;
  let unlistenAlbumChanged: UnlistenFn | null = null;
  let unlistenImagesChange: UnlistenFn | null = null;
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

  const localFolderAlbumIds = computed<string[]>(() =>
    albums.value.filter((a) => a.type === "local_folder").map((a) => a.id),
  );

  const isLocalFolderAlbum = (albumId: string | null | undefined): boolean => {
    if (!albumId) return false;
    return albums.value.some((a) => a.id === albumId && a.type === "local_folder");
  };

  const albumTree = computed((): AlbumTreeNode[] => buildAlbumTreeFromFlat(albums.value));

  const directCountsRef = (hide: boolean) =>
    hide ? albumHiddenDirectCounts : albumDirectCounts;

  const aggregateCountsRef = (hide: boolean) =>
    hide ? albumHiddenCounts : albumCounts;

  const aggregateStatsRef = (hide: boolean) =>
    hide ? albumHiddenStats : albumStats;

  const recomputeAlbumCounts = (hide = false) => {
    const albumIds = new Set(albums.value.map((a) => a.id));
    const roots = albums.value.filter((a) => a.parentId == null || !albumIds.has(a.parentId));
    const nodes = buildAlbumMediaNodes(roots, albums.value, directCountsRef(hide).value, hide);
    const nextCounts: Record<string, number> = {};
    const nextStats: Record<string, AlbumStats> = {};

    const collect = (node: AlbumMediaNode): AlbumStats => {
      const childStats = node.children.map(collect);
      const subAlbumCount = node.children.length + childStats.reduce(
        (sum, stats) => sum + stats.subAlbumCount,
        0,
      );
      const stats: AlbumStats = {
        directImageCount: node.directTotal,
        imageCount: node.aggregateTotal,
        subAlbumCount,
      };
      nextCounts[node.album.id] = stats.imageCount;
      nextStats[node.album.id] = stats;
      return stats;
    };

    for (const node of nodes) {
      collect(node);
    }

    aggregateCountsRef(hide).value = nextCounts;
    aggregateStatsRef(hide).value = nextStats;
  };

  const recomputeAllAlbumCounts = () => {
    recomputeAlbumCounts(false);
    recomputeAlbumCounts(true);
  };

  const setAlbumDirectCounts = (counts: Record<string, number>, hide = false) => {
    const next: Record<string, number> = {};
    for (const album of albums.value) {
      const raw = counts[album.id] ?? 0;
      next[album.id] = Number.isFinite(raw) ? Math.max(0, Number(raw)) : 0;
    }
    directCountsRef(hide).value = next;
    recomputeAlbumCounts(hide);
  };

  const patchAlbumDirectCounts = (counts: Record<string, number>, hide = false) => {
    const next = { ...directCountsRef(hide).value };
    for (const [id, raw] of Object.entries(counts)) {
      if (!id) continue;
      next[id] = Number.isFinite(raw) ? Math.max(0, Number(raw)) : 0;
    }
    directCountsRef(hide).value = next;
    recomputeAlbumCounts(hide);
  };

  const adjustAlbumDirectCounts = (albumIds: string[], delta: number, hide = false) => {
    if (albumIds.length === 0 || delta === 0) return;
    const next = { ...directCountsRef(hide).value };
    for (const id of albumIds) {
      next[id] = Math.max(0, (next[id] ?? 0) + delta);
    }
    directCountsRef(hide).value = next;
    recomputeAlbumCounts(hide);
  };

  const getAlbumDirectCounts = (hide = false) => directCountsRef(hide).value;

  const getAlbumCounts = (hide = false) => aggregateCountsRef(hide).value;

  const getAlbumStats = (hide = false) => aggregateStatsRef(hide).value;

  const refreshAlbumDirectCounts = async (hide = false, albumIds?: Iterable<string>) => {
    const ids = albumIds ?? albums.value.map((album) => album.id);
    patchAlbumDirectCounts(await fetchAlbumDirectCounts(ids, hide), hide);
  };

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
    albumDirectCounts.value[row.id] = 0;
    albumHiddenDirectCounts.value[row.id] = 0;
    recomputeAllAlbumCounts();
  };

  const applyAlbumDeletedPayload = (albumId: string) => {
    const desc = getDescendantIds(albumId);
    const removeIds = new Set<string>([albumId, ...desc]);
    albums.value = albums.value.filter((a) => !removeIds.has(a.id));
    for (const id of removeIds) {
      delete albumImages.value[id];
      delete albumPreviews.value[id];
      delete albumDirectCounts.value[id];
      delete albumHiddenDirectCounts.value[id];
      delete albumCounts.value[id];
      delete albumHiddenCounts.value[id];
      delete albumStats.value[id];
      delete albumHiddenStats.value[id];
    }
    recomputeAllAlbumCounts();
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
      album.parentId = parseParentId(changes.parentId);
      recomputeAllAlbumCounts();
    }
    if (Object.prototype.hasOwnProperty.call(changes, "folderStatus")) {
      album.folderStatus = parseFolderStatus(changes.folderStatus);
    }
  };

  const initEventListeners = async () => {
    if (eventListenersInitialized) return;
    eventListenersInitialized = true;
    try {
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
          if (p.directCounts && Object.keys(p.directCounts).length > 0) {
            patchAlbumDirectCounts(p.directCounts, false);
          } else {
            const uniqueImageCount = new Set(
              (p.imageIds ?? []).map((x) => String(x).trim()).filter(Boolean),
            ).size;
            if (p.reason === "add") {
              adjustAlbumDirectCounts(ids, uniqueImageCount, false);
            } else if (p.reason === "delete") {
              adjustAlbumDirectCounts(ids, -uniqueImageCount, false);
            }
          }
          const hiddenCountIds =
            ids.length === 0 || ids.includes(HIDDEN_ALBUM_ID)
              ? albums.value.map((album) => album.id)
              : ids;
          await refreshAlbumDirectCounts(true, hiddenCountIds);
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
      const rows = (await pathqlFetch<AlbumRow>("albums://all"))
        .map(albumFromProviderRow)
        .filter((a): a is Album => !!a);
      albums.value = rows.sort((a, b) => b.createdAt - a.createdAt);
      const ids = rows.map((a) => a.id);
      try {
        setAlbumDirectCounts(await fetchAlbumDirectCounts(ids, false), false);
      } catch (e) {
        console.warn("load album direct counts failed", e);
        setAlbumDirectCounts({}, false);
      }
      try {
        setAlbumDirectCounts(await fetchAlbumDirectCounts(ids, true), true);
      } catch (e) {
        console.warn("load hidden-filtered album direct counts failed", e);
        setAlbumDirectCounts({}, true);
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
        albumDirectCounts.value[row.id] = albumDirectCounts.value[row.id] ?? 0;
        albumHiddenDirectCounts.value[row.id] = albumHiddenDirectCounts.value[row.id] ?? 0;
        recomputeAllAlbumCounts();
      }
      return created;
    } catch (error: any) {
      const errorMessage =
        typeof error === "string" ? error : error?.message || String(error);
      throw new Error(errorMessage);
    }
  };

  const createLocalFolderAlbum = async (
    args: {
      name: string;
      syncFolder: string;
      recursive: boolean;
      parentId?: string | null;
    },
    opts: { reload?: boolean } = {},
  ) => {
    await initEventListeners();
    try {
      const createdRaw = await invoke<unknown>("add_local_folder_album", {
        name: args.name,
        parentId: args.parentId ?? null,
        syncFolder: args.syncFolder,
        recursive: args.recursive,
      });
      const rows = (Array.isArray(createdRaw) ? createdRaw : [createdRaw])
        .map((row) => normalizeAlbumRow(row as Record<string, unknown>))
        .filter((album) => !!album.id);

      const reload = opts.reload ?? true;
      if (reload) {
        await loadAlbums();
      } else {
        for (const row of rows) {
          const existingIndex = albums.value.findIndex((album) => album.id === row.id);
          if (existingIndex >= 0) {
            albums.value[existingIndex] = row;
          } else {
            albums.value.unshift(row);
          }
          albumDirectCounts.value[row.id] = albumDirectCounts.value[row.id] ?? 0;
          albumHiddenDirectCounts.value[row.id] = albumHiddenDirectCounts.value[row.id] ?? 0;
        }
        recomputeAllAlbumCounts();
      }
      return rows;
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
        recomputeAllAlbumCounts();
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
      await invoke<{
        added: number;
        attempted: number;
        canAdd: number;
        currentCount: number;
      }>("add_images_to_album", { albumId, imageIds });

      // 清除缓存，下一次自动刷新
      delete albumImages.value[albumId];
      delete albumPreviews.value[albumId];
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
    const rows = await pathqlFetch<Record<string, unknown>>(
      `gallery/album/${encodeURIComponent(albumId)}/order`
    );
    return rows.map(rowToImageInfo).filter((image) => !!image.id).map((image) => image.id);
  };

  return {
    albums,
    albumRoots,
    albumTree,
    albumImages,
    albumPreviews,
    albumDirectCounts,
    albumHiddenDirectCounts,
    albumCounts,
    albumHiddenCounts,
    albumStats,
    albumHiddenStats,
    loading,
    HIDDEN_ALBUM_ID,
    loadAlbums,
    getChildren,
    getDescendantIds,
    localFolderAlbumIds,
    isLocalFolderAlbum,
    getAlbumTreeExcluding,
    createAlbum,
    createLocalFolderAlbum,
    deleteAlbum,
    renameAlbum,
    moveAlbum,
    addImagesToAlbum,
    addTaskImagesToAlbum,
    removeImagesFromAlbum,
    loadAlbumPreview,
    getAlbumImageIds,
    getAlbumDirectCounts,
    getAlbumCounts,
    getAlbumStats,
  };
});
