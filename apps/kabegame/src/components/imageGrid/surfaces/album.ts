import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";
import { useAlbumStore, HIDDEN_ALBUM_ID } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import {
  stripComposablePathTail,
} from "@/utils/galleryPath";
import type { ImageInfo } from "@kabegame/core/types/image";
import type { ImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import type { GridSurfaceAdapter } from "../types";

/**
 * AlbumDetail（`/albums/:id`）的 grid surface。
 * 必须在 AlbumDetail.vue 的 setup 中调用（route store 不能过早实例化）。
 *
 * remove = 从画册移除（本地文件夹画册只读拦截）；deleteFile = 删除文件。
 * 这里只处理「本画册页面」的刷新；子画册预览刷新是 view 状态且需要在
 * grid 卸载（子画册 tab）时仍生效，由 view 自己监听 album-images-change。
 */
export function createAlbumDetailSurface(params: {
  albumId: () => string;
  albumName: () => string;
  isLocalFolder: () => boolean;
  analytics: ImageAnalytics;
}): GridSurfaceAdapter {
  const routeStore = useAlbumDetailRouteStore();
  const albumStore = useAlbumStore();
  const settingsStore = useSettingsStore();
  const t = i18n.global.t;

  const includesCurrentWallpaper = (images: ImageInfo[]) => {
    const current = settingsStore.values.currentWallpaperImageId;
    return !!current && images.some((img) => img.id === current);
  };
  const clearCurrentWallpaperIfIncluded = (images: ImageInfo[]) => {
    if (includesCurrentWallpaper(images)) {
      settingsStore.values.currentWallpaperImageId = null;
    }
  };
  const wallpaperHint = (included: boolean) =>
    included ? `\n\n${t("gallery.removeDialogWallpaperHint")}` : "";

  return {
    id: "album",
    routeStore,
    isActive: () => {
      const cur = router.currentRoute.value;
      const routeAlbumId = typeof cur.params.albumId === "string" ? cur.params.albumId : "";
      const id = params.albumId();
      return !!id && (!routeAlbumId || routeAlbumId === id) && !!params.albumName();
    },
    rootPathFallback: () =>
      params.albumId() ? `album/${params.albumId()}/1` : "",
    validatePath: (rawPath) => {
      const inner = rawPath.startsWith("hide/")
        ? rawPath.slice("hide/".length)
        : rawPath;
      return inner.startsWith("album/") && !inner.startsWith("album//");
    },
    computeCountPath: stripComposablePathTail,
    onCountError: (error, ctx) => {
      console.error("获取画册总图片数失败:", error);
      return ctx.images.value.length;
    },
    computeTargetPath: (page) => routeStore.computePath({ page }),
    imagesChange: {
      waitMs: 1000,
      filter: (p, ctx) => {
        if (!params.albumId()) return false;
        const reason = String(p.reason ?? "");
        const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
        const intersects = ids.some((id) =>
          ctx.images.value.some((img) => img.id === id),
        );
        if (reason === "delete") {
          return ids.length === 0 || intersects;
        }
        if (reason === "change") {
          if (routeStore.filters.wallpaperOrder) return true;
          return ids.length === 0 || intersects;
        }
        return true;
      },
      onRefresh: async (_p, ctx) => {
        const id = params.albumId();
        if (!id) return;
        delete albumStore.albumImages[id];
        await ctx.refreshPage();
      },
    },
    // 仅处理「本画册命中」（albumIds 空 = 全量、命中自身、或 HIDDEN 经 HideGate 影响可见性）
    albumImagesChange: {
      waitMs: 1000,
      filter: (p) => {
        const id = params.albumId();
        if (!id) return false;
        const affected = new Set(
          (p.albumIds ?? []).map((s) => String(s).trim()).filter(Boolean),
        );
        return affected.size === 0 || affected.has(id) || affected.has(HIDDEN_ALBUM_ID);
      },
      onRefresh: async (_p, ctx) => {
        const id = params.albumId();
        if (!id) return;
        delete albumStore.albumImages[id];
        await ctx.refreshPage();
      },
    },
    actionsOptions: () => ({
      removeText: t("gallery.removeFromAlbum"),
      deleteText: t("gallery.deleteImageFiles"),
      showDelete: true,
      hide: params.isLocalFolder() ? ["remove"] : [],
    }),
    forceUnhide: () => params.albumId() === HIDDEN_ALBUM_ID,
    addToAlbumExcludeIds: () => (params.albumId() ? [params.albumId()] : []),
    onAddedToAlbum: async () => {
      await albumStore.loadAlbums();
    },
    remove: {
      guard: () => {
        if (params.isLocalFolder()) {
          ElMessage.info(t("albums.localFolder.readOnlyHint"));
          return true;
        }
        return false;
      },
      dialogText: (count, extra) => ({
        title: t("gallery.removeFromAlbum"),
        message:
          (count > 1
            ? t("gallery.removeDialogMessageMulti", { count })
            : t("gallery.removeDialogMessageSingle")) +
          wallpaperHint(extra.includesCurrentWallpaper),
        confirmText: t("common.remove"),
      }),
      confirm: async (images) => {
        const id = params.albumId();
        if (!id) return;
        const count = images.length;
        try {
          await albumStore.removeImagesFromAlbum(
            id,
            images.map((img) => img.id),
          );
          clearCurrentWallpaperIfIncluded(images);
          // 列表由 images-change / album-images-change 事件驱动刷新，不做乐观更新
          ElMessage.success(
            count > 1
              ? t("gallery.removedFromAlbumCountSuccess", { count })
              : t("gallery.removedFromAlbumSuccess"),
          );
        } catch (error) {
          console.error("操作失败:", error);
          ElMessage.error(t("common.removeFail"));
        }
      },
    },
    deleteFile: {
      dialogText: (count, extra) => ({
        title: t("gallery.deleteImageFiles"),
        message:
          (count > 1
            ? t("gallery.deleteDialogMessageMulti", { count })
            : t("gallery.deleteDialogMessageSingle")) +
          wallpaperHint(extra.includesCurrentWallpaper),
        confirmText: t("common.delete"),
      }),
      confirm: async (images) => {
        const count = images.length;
        try {
          await invoke("batch_delete_images", {
            imageIds: images.map((img) => img.id),
          });
          clearCurrentWallpaperIfIncluded(images);
          ElMessage.success(
            count > 1
              ? t("gallery.deletedAndRemovedCountSuccess", { count })
              : t("gallery.deletedAndRemovedSuccess"),
          );
        } catch (error) {
          console.error("操作失败:", error);
          ElMessage.error(t("common.deleteFail"));
        }
      },
    },
    // 上划手势：直接从画册移除（不删文件、无确认框）
    swipeRemove: async (images) => {
      if (params.isLocalFolder()) {
        ElMessage.info(t("albums.localFolder.readOnlyHint"));
        return;
      }
      const id = params.albumId();
      if (!id || images.length === 0) return;
      try {
        await albumStore.removeImagesFromAlbum(
          id,
          images.map((img) => img.id),
        );
        clearCurrentWallpaperIfIncluded(images);
      } catch (error) {
        console.error("移除图片失败:", error);
        ElMessage.error(t("gallery.removeImageFailed"));
      }
    },
    analytics: params.analytics,
  };
}
