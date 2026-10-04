import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { i18n } from "@kabegame/i18n";
import router from "@/router";
import { useSurfImagesRouteStore } from "@/stores/surfImagesRoute";
import { stripComposablePathTail } from "@/utils/galleryPath";
import type { GridAdapter } from "../types";

/**
 * SurfImages（`/surf/:host/images`）的 grid adapter。
 * 必须在 SurfImages.vue 的 setup 中调用（route store 不能过早实例化）。
 */
export function createSurfImagesAdapter(params: {
  /** 当前 surf record id（images-change 事件按 surfRecordIds 过滤） */
  recordId: () => string;
}): GridAdapter {
  const routeStore = useSurfImagesRouteStore();
  const t = i18n.global.t;

  return {
    id: "surf",
    routeStore,
    isActive: () => router.currentRoute.value.name === "SurfImages" && !!routeStore.host,
    rootPathFallback: () => (routeStore.host ? `surf/${routeStore.host}/1` : ""),
    computeCountPath: stripComposablePathTail,
    onCountError: (_error, ctx) => ctx.images.value.length,
    onLoadError: (error) => {
      const e = error as { message?: string } | null;
      ElMessage.error(e?.message || String(error) || t("surf.loadImagesFailed"));
    },
    changes: {
      relevant: (batch) => {
        const rid = params.recordId();
        return !!rid && batch.images.size > 0 && (batch.wildcard.surf || batch.surfRecordIds.has(rid));
      },
    },
    actionsOptions: () => ({
      removeText: t("surf.removeText"),
      multiHide: ["favorite", "addToAlbum"],
    }),
    remove: {
      dialogText: (count) => ({
        title: t("surf.confirmDelete"),
        message: count > 1 ? t("surf.removeMessageMulti", { count }) : t("surf.removeMessageSingle"),
      }),
    },
  };
}
