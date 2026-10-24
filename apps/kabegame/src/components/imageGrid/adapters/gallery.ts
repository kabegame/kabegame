import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { resetGalleryRouteToDefault, useGalleryRouteStore } from "@/stores/galleryRoute";
import { buildGalleryCountPath, hasActiveQuery } from "@/utils/galleryPath";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { GridAdapter } from "../types";
import {
  albumChangeKinds,
  albumPatchTriggers,
  addedTrigger,
  patchTriggers,
  hiddenTrigger,
  on,
} from "@/services/kbEvents";
import { IS_WEB } from "@/env";

/**
 * Gallery（`/gallery`）的 grid adapter。
 * 必须在 Gallery.vue 的 setup 中调用。
 */
export function createGalleryAdapter(params: { analytics: ImageAnalytics }): GridAdapter {
  const routeStore = useGalleryRouteStore();
  const t = i18n.global.t;
  const view = () => ({ query: routeStore.query, sort: routeStore.sort, hide: routeStore.hide });

  const isDefaultGalleryRoute = () => !hasActiveQuery(routeStore.query);

  const resetGalleryRouteAfterLoadError = async () => {
    if (isDefaultGalleryRoute()) return;
    ElMessage.warning(t("gallery.galleryPathLoadFailedClearFilters"));
    await resetGalleryRouteToDefault();
  };

  return {
    id: "gallery",
    routeStore,
    viewState: view,
    isActive: () => router.currentRoute.value.path === "/gallery",
    computeCountPath: () => {
      const rootPath = buildGalleryCountPath(routeStore.effectiveNoAlbum, routeStore.query);
      return routeStore.hide ? `hide/${rootPath}` : rootPath;
    },
    computeUnfilteredCountPath: () =>
      routeStore.effectiveNoAlbum || routeStore.query.length > 0 ? (routeStore.hide ? "hide" : "gallery") : null,
    onCountError: (error) => {
      console.error("加载画廊总数失败:", error);
    },
    onLoadError: async (error, path) => {
      console.error("加载路径失败:", path, error);
      await resetGalleryRouteAfterLoadError();
    },
    // 空 `?path=` 表示回到默认画廊路径（如点击侧栏「画廊」）
    syncEmptyQueryPath: IS_WEB,
    refreshOn: [
      addedTrigger(view),
      ...patchTriggers(view),
      ...hiddenTrigger(view),
      on("album-images-added", () => routeStore.effectiveNoAlbum),
      on("album-images-deleted", () => routeStore.effectiveNoAlbum),
      on("album-images-change", () => routeStore.effectiveNoAlbum),
      on("albums-deleted", () => routeStore.effectiveNoAlbum),
      on("album-moved"),
      ...albumPatchTriggers((patch) => {
        const kinds = albumChangeKinds(patch);
        return kinds.structure || (routeStore.effectiveNoAlbum && kinds.row);
      }),
    ],
    actionsOptions: () => ({ removeText: t("gallery.delete") }),
    remove: {
      dialogText: (count) => ({
        title: t("gallery.confirmDelete"),
        message:
          count > 1
            ? t("gallery.removeFromGalleryMessageMulti", { count })
            : t("gallery.removeFromGalleryMessageSingle"),
      }),
    },
    analytics: params.analytics,
  };
}
