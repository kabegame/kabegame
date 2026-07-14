import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import {
  resetGalleryRouteToDefault,
  useGalleryRouteStore,
} from "@/stores/galleryRoute";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID } from "@/stores/albums";
import {
  buildGalleryCountPath,
  filterNoAlbum,
  hasActiveGalleryFilters,
} from "@/utils/galleryPath";
import type { ImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import type { GridSurfaceAdapter } from "../types";

/**
 * Gallery（`/gallery`）的 grid surface。
 * 必须在 Gallery.vue 的 setup 中调用。
 */
export function createGallerySurface(params: {
  analytics: ImageAnalytics;
}): GridSurfaceAdapter {
  const routeStore = useGalleryRouteStore();
  const t = i18n.global.t;

  const isDefaultGalleryRoute = () =>
    !hasActiveGalleryFilters(routeStore.filters) &&
    routeStore.page === 1 &&
    !routeStore.search.trim();

  const resetGalleryRouteAfterLoadError = async () => {
    if (isDefaultGalleryRoute()) return;
    ElMessage.warning(t("gallery.galleryPathLoadFailedClearFilters"));
    await resetGalleryRouteToDefault();
  };

  return {
    id: "gallery",
    routeStore,
    isActive: () => router.currentRoute.value.path === "/gallery",
    computeCountPath: () => {
      const rootPath = buildGalleryCountPath(routeStore.filters, routeStore.search);
      return routeStore.hide ? `hide/${rootPath}` : rootPath;
    },
    onCountError: resetGalleryRouteAfterLoadError,
    onLoadError: async (error, path) => {
      console.error("加载路径失败:", path, error);
      await resetGalleryRouteAfterLoadError();
    },
    // 空 `?path=` 表示回到默认画廊路径（如点击侧栏「画廊」）
    syncEmptyQueryPath: true,
    imagesChange: {
      waitMs: 100,
      filter: (p, ctx) => {
        const reason = String(p.reason ?? "");
        const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
        const intersects =
          ids.length > 0 &&
          ids.some((id) => ctx.images.value.some((img) => img.id === id));

        if (reason === "delete") {
          return ids.length === 0 || intersects;
        }
        if (reason === "change") {
          if (routeStore.filters.wallpaperOrder) return true;
          return ids.length === 0 || intersects;
        }
        if (reason === "rename") {
          if (routeStore.filters.name) return true;
          return ids.length === 0 || intersects;
        }
        return true;
      },
    },
    /** 画册成员变化：FAVORITE 就地更新星标；HIDDEN / no-album 影响 gallery 可见性，需全量刷新。 */
    albumImagesChange: {
      waitMs: 100,
      filter: (p) => {
        const ids = p.albumIds ?? [];
        return (
          filterNoAlbum(routeStore.filters) ||
          ids.includes(FAVORITE_ALBUM_ID) ||
          ids.includes(HIDDEN_ALBUM_ID)
        );
      },
      onRefresh: async (p, ctx) => {
        const ids = p.albumIds ?? [];
        if (filterNoAlbum(routeStore.filters) || ids.includes(HIDDEN_ALBUM_ID)) {
          await ctx.refreshPage();
          return;
        }
        const idSet = new Set(p.imageIds ?? []);
        if (idSet.size === 0) return;
        const fav = p.reason === "add";
        ctx.images.value = ctx.images.value.map((img) =>
          idSet.has(img.id) ? { ...img, favorite: fav } : img,
        );
      },
    },
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
