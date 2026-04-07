<template>
  <div class="surf-images-page">
    <div class="surf-images-scroll-container">
      <ImageGrid
        ref="surfViewRef"
        class="surf-grid"
        :images="images"
        :enable-virtual-scroll="!IS_ANDROID"
        :enable-ctrl-wheel-adjust-columns="!IS_ANDROID"
        :enable-ctrl-key-adjust-columns="!IS_ANDROID"
        :actions="imageActions"
        :on-context-command="handleImageMenuCommand"
      >
        <template #before-grid>
          <PageHeader
            :title="recordTitle"
            :subtitle="lastVisitSubtitle"
            :show="[]"
            show-back
            sticky
            @back="goBack"
          />

          <div class="surf-page-size-toolbar">
            <GalleryPageSizeControl
              :page-size="pageSize"
              variant="gallery"
              android-ui="inline"
            />
          </div>

          <GalleryBigPaginator
            :total-count="totalImagesCount"
            :current-page="currentPage"
            :big-page-size="pageSize"
            :is-sticky="true"
            @jump-to-page="handleJumpToPage"
          />
        </template>
      </ImageGrid>
    </div>

    <RemoveImagesConfirmDialog
      v-model="showRemoveDialog"
      v-model:delete-files="removeDeleteFiles"
      :message="removeDialogMessage"
      :title="$t('surf.confirmDelete')"
      :checkbox-label="$t('gallery.deleteSourceFilesCheckboxLabel')"
      :danger-text="$t('gallery.deleteSourceFilesDangerText')"
      :safe-text="$t('gallery.deleteSourceFilesSafeText')"
      :hide-checkbox="IS_ANDROID"
      @confirm="confirmRemoveImages"
    />

    <AddToAlbumDialog
      v-model="showAddToAlbumDialog"
      :image-ids="addToAlbumImageIds"
      @added="handleAddedToAlbum"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onActivated, onDeactivated, onBeforeUnmount, ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { setWallpaperByImageIdWithModeFallback } from "@/utils/wallpaperMode";
import { listen } from "@tauri-apps/api/event";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { createImageActions } from "@/actions/imageActions";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { useAlbumStore } from "@/stores/albums";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useSurfImagesRouteStore } from "@/stores/surfImagesRoute";
import { useImageOperations } from "@/composables/useImageOperations";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useImageTypes } from "@/composables/useImageTypes";
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { openLocalImage } from "@/utils/openLocalImage";
import { IS_ANDROID } from "@kabegame/core/env";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useI18n } from "@kabegame/i18n";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const surfStore = useSurfStore();
const albumStore = useAlbumStore();
const { FAVORITE_ALBUM_ID } = storeToRefs(albumStore);
const settingsStore = useSettingsStore();
const pageSize = computed(() => {
  const n = Number(settingsStore.values.galleryPageSize);
  return n === 100 || n === 500 || n === 1000 ? n : 100;
});
const { set: setWallpaperRotationEnabled } = useSettingKeyState("wallpaperRotationEnabled");
const { set: setWallpaperRotationAlbumId } = useSettingKeyState("wallpaperRotationAlbumId");

const images = ref<ImageInfo[]>([]);
const totalImagesCount = ref(0);
const loading = ref(false);
const record = ref<SurfRecord | null>(null);
const recordId = ref("");
const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();
const surfViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);
const currentWallpaperImageId = ref<string | null>(null);

const showRemoveDialog = ref(false);
const removeDialogMessage = ref("");
const removeDeleteFiles = ref(false);
const pendingRemoveImages = ref<ImageInfo[]>([]);
const showAddToAlbumDialog = ref(false);
const addToAlbumImageIds = ref<string[]>([]);

const imageActions = computed(() =>
  createImageActions({
    removeText: t("surf.removeText"),
    multiHide: ["favorite", "addToAlbum"],
  })
);

const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const { handleCopyImage } = useImageOperations(
  images,
  currentWallpaperImageId,
  surfViewRef,
  () => {},
  async () => {
    await reloadAllImages();
  }
);

const clearSelection = () => {
  surfViewRef.value?.clearSelection?.();
};

const toggleFavoriteForImages = async (imgs: ImageInfo[]) => {
  if (imgs.length === 0) return;
  const desiredFavorite = imgs.some((img) => !(img.favorite ?? false));
  const toChange = imgs.filter((img) => (img.favorite ?? false) !== desiredFavorite);
  if (toChange.length === 0) return;

  const results = await Promise.allSettled(
    toChange.map((img) =>
      invoke("toggle_image_favorite", {
        imageId: img.id,
        favorite: desiredFavorite,
      })
    )
  );
  const succeededIds: string[] = [];
  results.forEach((r, idx) => {
    if (r.status === "fulfilled") succeededIds.push(toChange[idx]!.id);
  });
  if (succeededIds.length === 0) {
    ElMessage.error(t("surf.operationFailed"));
    return;
  }

  // 列表与画册缓存由 album-images-change / images-change 事件驱动刷新

  ElMessage.success(desiredFavorite ? t("surf.favoritedCount", { count: succeededIds.length }) : t("surf.unfavoritedCount", { count: succeededIds.length }));
  clearSelection();
};

const setWallpaper = async (imagesToProcess: ImageInfo[]) => {
  try {
    if (imagesToProcess.length > 1) {
      await settingsStore.loadAll();
      await albumStore.loadAlbums();
      let albumName = t("surf.desktopAlbumName", { n: 1 });
      let counter = 1;
      while (albumStore.albums.some((a) => a.name === albumName)) {
        counter++;
        albumName = t("surf.desktopAlbumName", { n: counter });
      }
      const createdAlbum = await albumStore.createAlbum(albumName);
      const imageIds = imagesToProcess.map((img) => img.id);
      await albumStore.addImagesToAlbum(createdAlbum.id, imageIds);
      await settingsStore.loadMany(["wallpaperRotationEnabled", "wallpaperRotationAlbumId"]);
      if (!settingsStore.values.wallpaperRotationEnabled) {
        await setWallpaperRotationEnabled(true);
      }
      await setWallpaperRotationAlbumId(createdAlbum.id);
      ElMessage.success(t("surf.rotationStarted", { name: albumName, count: imageIds.length }));
    } else {
      await setWallpaperByImageIdWithModeFallback(imagesToProcess[0].id);
      currentWallpaperImageId.value = imagesToProcess[0].id;
      ElMessage.success(t("surf.wallpaperSetSuccess"));
    }
    clearSelection();
  } catch (error: any) {
    console.error("设置壁纸失败:", error);
    ElMessage.error(error?.message || String(error) || t("surf.wallpaperSetFailed"));
  }
};

const handleAddedToAlbum = () => {
  clearSelection();
};

const handleImageMenuCommand = async (
  payload: ContextCommandPayload
): Promise<import("@/components/ImageGrid.vue").ContextCommand | null> => {
  const command = payload.command as string;
  if (command === "detail") return command;

  const image: ImageInfo | undefined =
    images.value.find((i) => i.id === payload?.image?.id) ?? (payload?.image as ImageInfo | undefined);
  if (!image) return null;

  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess: ImageInfo[] = isMultiSelect
    ? images.value.filter((img) => selectedSet.has(img.id))
    : [image];

  switch (command) {
    case "copy":
      if (imagesToProcess[0]) await handleCopyImage(imagesToProcess[0]);
      break;
    case "favorite":
      if (imagesToProcess.length > 0) await toggleFavoriteForImages(imagesToProcess);
      break;
    case "openFolder":
      if (!isMultiSelect && imagesToProcess[0]?.localPath) {
        try {
          await invoke("open_file_folder", { filePath: imagesToProcess[0].localPath });
        } catch (e) {
          console.error("打开文件夹失败:", e);
          ElMessage.error(t("surf.openFolderFailed"));
        }
      }
      break;
    case "addToAlbum":
      if (imagesToProcess.length > 0) {
        addToAlbumImageIds.value = imagesToProcess.map((img) => img.id);
        showAddToAlbumDialog.value = true;
      }
      break;
    case "wallpaper":
      if (imagesToProcess.length > 0) await setWallpaper(imagesToProcess);
      break;
    case "share":
      if (!isMultiSelect && imagesToProcess[0]) {
        try {
          const img = imagesToProcess[0];
          const filePath = img.localPath;
          if (!filePath) {
            ElMessage.error(t("surf.pathNotExist"));
            break;
          }
          const ext = filePath.split(".").pop()?.toLowerCase() || "";
          await loadImageTypes();
          const mimeType = getMimeTypeForImage(img, ext);
          await invoke("share_file", { filePath, mimeType });
        } catch (e) {
          console.error("分享失败:", e);
          ElMessage.error(t("surf.shareFailed"));
        }
      }
      break;
    case "open":
      if (!isMultiSelect && imagesToProcess[0]?.localPath) {
        try {
          await openLocalImage(imagesToProcess[0].localPath);
        } catch (e) {
          console.error("打开文件失败:", e);
          ElMessage.error(t("surf.openFileFailed"));
        }
      }
      break;
    case "remove":
      if (imagesToProcess.length === 0) return null;
      pendingRemoveImages.value = imagesToProcess;
      const count = imagesToProcess.length;
      removeDialogMessage.value = count > 1 ? t("surf.removeMessageMulti", { count }) : t("surf.removeMessageSingle");
      removeDeleteFiles.value = false;
      showRemoveDialog.value = true;
      break;
  }
  return null;
};

const confirmRemoveImages = async () => {
  const imagesToRemove = pendingRemoveImages.value;
  if (imagesToRemove.length === 0) {
    showRemoveDialog.value = false;
    return;
  }

  const count = imagesToRemove.length;
  const shouldDeleteFiles = removeDeleteFiles.value;
  showRemoveDialog.value = false;

  try {
    const imageIds = imagesToRemove.map((img) => img.id);
    if (shouldDeleteFiles) {
      await invoke("batch_delete_images", { imageIds });
    } else {
      await invoke("batch_remove_images", { imageIds });
    }

    clearSelection();
    // 列表由 images-change（带 surfRecordIds）节流刷新，见 startListening

    const actionKey = shouldDeleteFiles ? "common.delete" : "common.remove";
    const actionLabel = t(actionKey);
    ElMessage.success(count > 1 ? t("surf.removedCount", { action: actionLabel, count }) : t("surf.removedSingle", { action: actionLabel }));
  } catch (e) {
    console.error("删除图片失败:", e);
    const actionLabel = t(shouldDeleteFiles ? "common.delete" : "common.remove");
    ElMessage.error(t("surf.actionFailed", { action: actionLabel }));
  }
};

const isOnSurfImagesRoute = computed(() => String(route.name ?? "") === "SurfImages");
const surfImagesRouteStore = useSurfImagesRouteStore();
const currentPath = computed(() => surfImagesRouteStore.currentPath);
const currentPage = computed(() => surfImagesRouteStore.page);
const providerRootPath = computed(() => `surf/${surfImagesRouteStore.recordId}`);

const recordTitle = computed(() => record.value?.host ?? t("surf.surfImagesTitle"));
const lastVisitSubtitle = computed(() => {
  const r = record.value;
  if (!r?.lastVisitAt) return "";
  const date = new Date(r.lastVisitAt * 1000);
  return t("surf.lastSurfTime") + date.toLocaleString();
});

const fetchPageImages = async (path: string) => {
  clearImageMetadataCache();
  const res = await invoke<{
    total?: number;
    entries?: Array<{ kind: string; image?: ImageInfo }>;
  }>("browse_gallery_provider", { path, pageSize: pageSize.value });
  const list: ImageInfo[] = (res?.entries ?? [])
    .filter((e: any) => e?.kind === "image")
    .map((e: any) => e.image as ImageInfo);
  return {
    total: res?.total ?? 0,
    images: list,
  };
};

const loadCurrentPage = async () => {
  if (!recordId.value) return;
  if (!providerRootPath.value.startsWith(`surf/${recordId.value}`)) return;
  loading.value = true;
  try {
    const path = currentPath.value || `${providerRootPath.value}/1`;
    const result = await fetchPageImages(path);
    images.value = result.images;
    totalImagesCount.value = result.total;
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.loadImagesFailed"));
  } finally {
    loading.value = false;
  }
};

const handleJumpToPage = async (page: number) => {
  await surfImagesRouteStore.navigate({ page });
};

watch(
  pageSize,
  async (_v, prev) => {
    if (prev === undefined) return;
    await surfImagesRouteStore.navigate({ page: 1 });
    await loadCurrentPage();
  },
);

const reloadAllImages = async () => {
  await loadCurrentPage();
};

useImagesChangeRefresh({
  enabled: isOnSurfImagesRoute,
  waitMs: 500,
  filter: (p) => {
    const rid = recordId.value;
    return !!rid && (p.surfRecordIds?.includes(rid) ?? false);
  },
  onRefresh: async () => {
    await reloadAllImages();
  },
});

const initRecord = async (id: string) => {
  recordId.value = id;
  images.value = [];
  totalImagesCount.value = 0;
  record.value = null;

  const r = surfStore.records.find((rec) => rec.id === id) ?? (await surfStore.getRecord(id));
  record.value = r ?? null;
  const rawPath = route.query.path;
  const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
  if (qp.startsWith(`surf/${id}/`)) {
    surfImagesRouteStore.syncFromUrl(qp);
  } else {
    await surfImagesRouteStore.navigate({ recordId: id, page: 1 });
  }
  await loadCurrentPage();
};

const goBack = () => {
  router.push("/surf");
};

// keep-alive: 监听路由参数变化
watch(
  () => route.params.id,
  async (newId) => {
    if (!isOnSurfImagesRoute.value) return;
    if (newId && typeof newId === "string" && newId !== recordId.value) {
      await initRecord(newId);
    }
  }
);

watch(
  () => currentPath.value,
  async (newPath) => {
    if (!isOnSurfImagesRoute.value) return;
    if (!recordId.value) return;
    if (!newPath) return;
    const root = `surf/${recordId.value}`;
    if (!newPath.startsWith(`${root}/`)) {
      await surfImagesRouteStore.navigate({ recordId: recordId.value, page: 1 });
      return;
    }
    await loadCurrentPage();
  }
);

watch(
  () => route.query.path,
  (rawPath) => {
    const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
    if (!qp.trim()) return;
    if (qp !== currentPath.value) {
      surfImagesRouteStore.syncFromUrl(qp);
    }
  },
  { immediate: true }
);

// images-change：见 useImagesChangeRefresh（与画册等页面统一）
// surf-records-change：畅游记录被删时返回列表
let unlistenRecordsChange: (() => void) | null = null;

const startListening = async () => {
  if (unlistenRecordsChange) return;
  unlistenRecordsChange = await listen<Record<string, unknown>>("surf-records-change", (event) => {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (String(p.type) !== "SurfRecordDeleted") return;
    if (String(p.surfRecordId ?? "") !== recordId.value) return;
    goBack();
  });
};

const stopListening = () => {
  if (unlistenRecordsChange) {
    unlistenRecordsChange();
    unlistenRecordsChange = null;
  }
};

onMounted(async () => {
  const id = String(route.params.id || "");
  if (id) await initRecord(id);
  await startListening();
});

onBeforeUnmount(() => {
  stopListening();
});

onActivated(async () => {
  const id = String(route.params.id || "");
  if (id && id !== recordId.value) {
    await initRecord(id);
  }
  await startListening();
});

onDeactivated(() => {
  stopListening();
  surfViewRef.value?.clearSelection?.();
});
</script>

<style scoped lang="scss">
.surf-images-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.surf-images-scroll-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px;
}

.surf-grid {
  flex: 1;
  min-height: 0;
}

.surf-page-size-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
