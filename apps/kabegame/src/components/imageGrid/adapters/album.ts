import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID, removeImagesFromAlbum } from "@/services/albums";
import { useSettingsStore } from "@/stores/settings";
import { stripComposablePathTail } from "@/utils/galleryPath";
import type { ImageInfo } from "@/types/image";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { GridAdapter, GridRemoveConfig } from "../types";
import { albumChangeKinds, albumPatchTriggers, hiddenTrigger, patchTriggers, on } from "@/services/kbEvents";

/**
 * 画册页（`/albums`）中栏的 grid adapter。
 * 必须在 Albums.vue 的 setup 中调用（route store 不能过早实例化）。
 *
 * remove = 从画册移除（本地文件夹画册下委托 deleteFile）；deleteFile = 删除文件。
 * 这里只处理当前选中画册的图片刷新。
 */
export function createAlbumDetailAdapter(params: {
  albumId: () => string;
  albumName: () => string;
  isLocalFolder: () => boolean;
  analytics: ImageAnalytics;
}): GridAdapter {
  const routeStore = useAlbumDetailRouteStore();
  const settingsStore = useSettingsStore();
  const t = i18n.global.t;
  const view = () => ({ query: routeStore.query, sort: routeStore.sort, hide: routeStore.hide });

  const includesCurrentWallpaper = (images: ImageInfo[]) => {
    const current = settingsStore.values.currentWallpaperImageId;
    return !!current && images.some((img) => img.id === current);
  };
  const clearCurrentWallpaperIfIncluded = (images: ImageInfo[]) => {
    if (includesCurrentWallpaper(images)) {
      settingsStore.values.currentWallpaperImageId = null;
    }
  };
  const wallpaperHint = (included: boolean) => (included ? `\n\n${t("gallery.removeDialogWallpaperHint")}` : "");

  const deleteFileConfig: GridRemoveConfig = {
    dialogText: (count, extra) => ({
      title: t("gallery.deleteImageFiles"),
      message:
        (count > 1 ? t("gallery.deleteDialogMessageMulti", { count }) : t("gallery.deleteDialogMessageSingle")) +
        wallpaperHint(extra.includesCurrentWallpaper),
      confirmText: t("common.delete"),
    }),
    confirm: async (images, ctx) => {
      const count = images.length;
      try {
        await ctx.mutate(() => invoke("batch_delete_images", { imageIds: images.map((img) => img.id) }));
        clearCurrentWallpaperIfIncluded(images);
        ElMessage.success(
          count > 1 ? t("gallery.deletedAndRemovedCountSuccess", { count }) : t("gallery.deletedAndRemovedSuccess"),
        );
      } catch (error) {
        console.error("操作失败:", error);
        ElMessage.error(t("common.deleteFail"));
      }
    },
  };

  return {
    id: "album",
    routeStore,
    viewState: view,
    isActive: () => {
      const cur = router.currentRoute.value;
      const routeAlbumId = typeof cur.params.albumId === "string" ? cur.params.albumId : "";
      const id = params.albumId();
      return !!id && (!routeAlbumId || routeAlbumId === id) && !!params.albumName();
    },
    rootPathFallback: () => (params.albumId() ? `album/${params.albumId()}` : ""),
    validatePath: (rawPath) => {
      const inner = rawPath.startsWith("hide/") ? rawPath.slice("hide/".length) : rawPath;
      return inner.startsWith("album/") && !inner.startsWith("album//");
    },
    computeCountPath: stripComposablePathTail,
    onCountError: (error, ctx) => {
      console.error("获取画册总图片数失败:", error);
      return ctx.images.value.length;
    },
    refreshOn: [
      ...patchTriggers(view),
      on("album-images-added", (payload) => !!params.albumId() && payload.albumId === params.albumId()),
      on("album-images-deleted", (payload) => !!params.albumId() && payload.albumId === params.albumId()),
      // 隐藏 / 取消隐藏只发隐藏画册自身的事件：hide 开启就刷新，关闭时由 imagePatches$ 按 id 打 isHidden 补丁
      ...hiddenTrigger(view),
      on("album-images-change", (payload) => !!params.albumId() && payload.albumId === params.albumId()),
      on("albums-deleted", (payload) => payload.albums.some((album) => album.id === params.albumId())),
      on("album-moved", (payload) => payload.id === params.albumId()),
      ...albumPatchTriggers((patch) => {
        if (!params.albumId() || patch.id !== params.albumId()) return false;
        const kinds = albumChangeKinds(patch);
        return kinds.structure || kinds.row;
      }),
    ],
    actionsOptions: () => ({
      removeText: t("gallery.removeFromAlbum"),
      deleteText: t("gallery.deleteImageFiles"),
      showDelete: true,
      hide: [
        ...(params.isLocalFolder() ? ["remove"] : []),
        ...(params.albumId() === FAVORITE_ALBUM_ID ? ["favorite"] : []),
      ],
    }),
    forceUnhide: () => params.albumId() === HIDDEN_ALBUM_ID,
    addToAlbumExcludeIds: () => (params.albumId() ? [params.albumId()] : []),
    remove: {
      dialogText: (count, extra) =>
        params.isLocalFolder()
          ? deleteFileConfig.dialogText(count, extra)
          : {
              title: t("gallery.removeFromAlbum"),
              message:
                (count > 1
                  ? t("gallery.removeDialogMessageMulti", { count })
                  : t("gallery.removeDialogMessageSingle")) + wallpaperHint(extra.includesCurrentWallpaper),
              confirmText: t("common.remove"),
            },
      confirm: async (images, ctx) => {
        if (params.isLocalFolder()) {
          await deleteFileConfig.confirm?.(images, ctx);
          return;
        }
        const id = params.albumId();
        if (!id) return;
        const count = images.length;
        try {
          await ctx.mutate(() =>
            removeImagesFromAlbum(
              id,
              images.map((img) => img.id),
            ),
          );
          clearCurrentWallpaperIfIncluded(images);
          ElMessage.success(
            count > 1 ? t("gallery.removedFromAlbumCountSuccess", { count }) : t("gallery.removedFromAlbumSuccess"),
          );
        } catch (error) {
          console.error("操作失败:", error);
          ElMessage.error(t("common.removeFail"));
        }
      },
    },
    deleteFile: deleteFileConfig,
    // 上划手势：直接从画册移除（不删文件、无确认框）
    swipeRemove: async (images, ctx) => {
      if (params.isLocalFolder()) {
        ElMessage.info(t("albums.localFolder.readOnlyHint"));
        return;
      }
      const id = params.albumId();
      if (!id || images.length === 0) return;
      try {
        await ctx.mutate(() =>
          removeImagesFromAlbum(
            id,
            images.map((img) => img.id),
          ),
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
