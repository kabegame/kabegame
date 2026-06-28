<template>
  <div class="gallery-page">
    <div class="gallery-container" v-pull-to-refresh="pullToRefreshOpts">
      <div class="gallery-content-layout">
        <div class="gallery-grid-pane">
          <ImageGrid 
            ref="galleryViewRef" 
            :images="displayedImages" 
            :enable-ctrl-wheel-adjust-columns="!isCompact"
            hide-scrollbar 
            :enable-ctrl-key-adjust-columns="!isCompact"
            :enable-virtual-scroll="true"
            :loading="loading || isRefreshing" :loading-overlay="showLoading || isRefreshing" :actions="imageActions"
            :on-context-command="handleGridContextCommand" @image-dblclick="handleImageDoubleOpen"
            @preview-navigate="handlePreviewNavigate" @preview-page-boundary="handlePreviewPageBoundary"
            @preview-detail-toggle="handlePreviewDetailToggle"
            @preview-close="handlePreviewClose" scroll-whole-container>
            <template #before-grid>
              <!-- 顶部工具栏 -->
              <GalleryToolbar :total-count="totalImagesCount" :big-page-enabled="bigPageEnabled"
                :filters="galleryRouteStore.filters"
                :sort="galleryRouteStore.sort" :page-size="pageSize" :search="search"
                :provider-context-prefix="galleryRouteStore.contextPath"
                @refresh="handleManualRefresh" @show-help="openHelpDrawer" @show-quick-settings="openQuickSettingsDrawer"
                @show-crawler-dialog="handleShowCrawlerDialog" @show-local-import="handleShowLocalImport"
                @open-collect-menu="handleOpenCollectMenu"
                @update:filters="(filters) => galleryRouteStore.navigate({ filters, page: 1 }, { push: true })"
                @update:sort="(sort) => galleryRouteStore.navigate({ sort })"
                @update:pageSize="(ps) => galleryRouteStore.navigate({ page: 1, pageSize: ps })"
                @update:search="(s) => galleryRouteStore.navigate({ page: 1, search: s })" />

              <!-- 大页分页器 -->
              <GalleryBigPaginator :total-count="totalImagesCount" :current-page="currentPage" :big-page-size="pageSize"
                :is-sticky="true" @jump-to-page="handleJumpToBigPage" />
            </template>

            <!-- 无图片空状态：使用 ImageGrid 的 empty 插槽（只隐藏 ImageItem，不影响 header/插槽挂载） -->
            <template #empty>
              <div v-if="displayedImages.length === 0 && !loading && !isRefreshing" :key="'empty-' + refreshKey"
                class="empty fade-in">
                <template>
                  <EmptyState />
                  <el-button type="primary" class="empty-action-btn" @click="handleEmptyStateCollect">
                    <el-icon>
                      <Plus />
                    </el-icon>
                    {{ $t('gallery.startCollect') }}
                  </el-button>
                </template>
              </div>
            </template>
          </ImageGrid>
        </div>
      </div>
    </div>

    <!-- 收集对话框（非 Android：本地渲染；Android：由 App.vue 全局承载） -->
    <CrawlerDialog v-if="!isCompact" :model-value="crawlerDialog.isOpen.value" :initial-config="crawlerDialogInitialConfig" @update:model-value="crawlerDialog.close" />
    <LocalImportDialog v-if="!isCompact" :model-value="localImportDialog.isOpen.value" @update:model-value="localImportDialog.close" />


    <!-- 永久删除确认对话框 -->
    <RemoveImagesConfirmDialog :open="removeDialog.isOpen.value" :z-index="removeDialog.zIndex.value" :message="removeDialogMessage"
      :title="$t('gallery.confirmDelete')" hide-checkbox @close="removeDialog.close()" @confirm="confirmRemoveImages" />

    <AddToAlbumDialog :open="addToAlbumDialog.isOpen.value" :z-index="addToAlbumDialog.zIndex.value" :image-ids="addToAlbumImageIds" @close="addToAlbumDialog.close()" @added="handleAddedToAlbum" />

    <!-- 桌面：空状态/无下拉时用对话框选择 本地/网络 -->
    <el-dialog :model-value="collectMenuDialog.isOpen.value" :z-index="collectMenuDialog.zIndex.value" :title="$t('gallery.chooseCollectMethod')" width="360px" destroy-on-close
      class="collect-menu-dialog" @update:model-value="collectMenuDialog.close">
      <div class="collect-menu-options">
        <div class="collect-menu-option" @click="onDesktopCollectLocal">
          <el-icon>
            <FolderOpened />
          </el-icon>
          <span>{{ $t('gallery.local') }}</span>
        </div>
        <div class="collect-menu-option" @click="onDesktopCollectNetwork">
          <el-icon>
            <Connection />
          </el-icon>
          <span>{{ $t('gallery.network') }}</span>
        </div>
      </div>
    </el-dialog>

    <!-- Android：收集方式选择器（本地 → MediaPicker，远程 → 收集 drawer） -->
    <CollectSourcePicker v-if="uiStore.isCompact" :model-value="collectSourcePicker.isOpen.value" @update:model-value="collectSourcePicker.close" @select="handleCollectSourceSelect" />
    <!-- 安卓媒体选择器（本地导入） -->
    <MediaPicker v-if="uiStore.isCompact" :model-value="mediaPicker.isOpen.value" @update:model-value="mediaPicker.close" @select="handleMediaPickerSelect" />

    <!-- 整理对话框：由 header 的 OrganizeHeaderControl 触发打开，确认后回传参数给 header 启动整理 -->
    <OrganizeDialog :model-value="organizeStore.dialogOpen" @update:model-value="onOrganizeDialogVisible" @confirm="onOrganizeConfirm" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { storeToRefs } from "pinia";
import { invoke } from "@/api/rpc";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Plus, Picture, FolderOpened, Connection } from "@element-plus/icons-vue";
import { useCrawlerStore } from "@/stores/crawler";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useUiStore } from "@kabegame/core/stores/ui";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import LocalImportDialog from "@/components/LocalImportDialog.vue";
import MediaPicker from "@/components/MediaPicker.vue";
import CollectSourcePicker from "@/components/CollectSourcePicker.vue";
import OrganizeDialog from "@/components/OrganizeDialog.vue";
import { useOrganizeStore, type OrganizeOptions } from "@/stores/organize";
import { createImageActions } from "@/actions/imageActions";
import EmptyState from "@/components/common/EmptyState.vue";
import RemoveImagesConfirmDialog from "@kabegame/core/components/common/RemoveImagesConfirmDialog.vue";
import AddToAlbumDialog from "@/components/AddToAlbumDialog.vue";
import { useGalleryImages } from "@/composables/useGalleryImages";
import { useImageOperations } from "@/composables/useImageOperations";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useLoadingDelay } from "@kabegame/core/composables/useLoadingDelay";
import type { ContextCommand, ContextCommandPayload } from "@/components/ImageGrid.vue";
import { usePagedGallery } from "@/composables/usePagedGallery";
import { resetGalleryRouteToDefault, useGalleryRouteStore } from "@/stores/galleryRoute";
import { buildGalleryCountPath, filterNoAlbum, hasActiveGalleryFilters } from "@/utils/galleryPath";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { createImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import { useModal } from "@kabegame/core/composables/useModal";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import { useImageTypes } from "@/composables/useImageTypes";
import { pickImages, pickVideos, type PickFolderResult } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useI18n } from "@kabegame/i18n";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

// ---------- Component setup ----------
const { t } = useI18n();

// ---------- Stores and route state ----------
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);
const crawlerStore = useCrawlerStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettingsDrawer = () => quickSettingsDrawer.open("gallery");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("gallery");
const settingsStore = useSettingsStore();
const albumStore = useAlbumStore();
const { load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const route = useRoute();
const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();
const { pageSize, search } = storeToRefs(galleryRouteStore);

const currentPath = computed(() => galleryRouteStore.currentPath);
let lastTrackedGalleryPath: string | null = null;

// ---------- Analytics ----------
const analytics = createImageAnalytics(() => ({ path: currentPath.value }));

watch(
  currentPath,
  (path) => {
    if (!IS_WEB) return;
    if (!path) return;
    if (path === lastTrackedGalleryPath) return;
    lastTrackedGalleryPath = path;
    analytics.track("gallery_path");
  },
  { immediate: true }
);

// ---------- Filter flags ----------
const isWallpaperOrderBrowse = computed(
  () => !!galleryRouteStore.filters.wallpaperOrder
);

const isNoAlbumBrowse = computed(
  () => filterNoAlbum(galleryRouteStore.filters)
);

const isNameBrowse = computed(
  () => !!galleryRouteStore.filters.name
);

// ---------- Route synchronization ----------
watch(
  () => route.query.path,
  (rawPath) => {
    if (route.path !== "/gallery") return;
    const qp = Array.isArray(rawPath) ? String(rawPath[0] ?? "") : String(rawPath ?? "");
    if (!qp.trim()) {
      galleryRouteStore.syncFromUrl("");
      return;
    }
    if (qp !== currentPath.value) {
      galleryRouteStore.syncFromUrl(qp);
    }
  },
  { immediate: true }
);

// ---------- Dialog and import flow ----------
const listenersCreated = ref(false);
const crawlerDialog = useModal();
const localImportDialog = useModal();
const mediaPicker = useModal();
const collectSourcePicker = useModal();
const collectMenuDialog = useModal();
const crawlerDialogInitialConfig = ref<{
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
} | undefined>(undefined);

// 桌面：打开收集（网络）对话框。Android 上由「开始收集」→ CollectSourcePicker → 远程 打开 drawer
const handleShowCrawlerDialog = () => {
  analytics.track("gallery_import_entry", { entry: "network" });
  crawlerDialog.open();
};

const handleShowLocalImport = () => {
  analytics.track("gallery_import_entry", { entry: "local" });
  localImportDialog.open();
};

const handleOpenCollectMenu = () => {
  analytics.track("gallery_import_entry", { entry: "collect_menu" });
  collectSourcePicker.open();
};

// 整理对话框：本体渲染在 Gallery，开关与确认通过 organize store 与 header 桥接
const organizeStore = useOrganizeStore();
const onOrganizeDialogVisible = (visible: boolean) => {
  if (visible) organizeStore.openDialog();
  else organizeStore.closeDialog();
};
const onOrganizeConfirm = (options: OrganizeOptions) => {
  organizeStore.closeDialog();
  organizeStore.requestStart(options);
};

// 空状态按钮：与工具栏一致，安卓打开「本地/远程」选择 picker，桌面打开选择对话框
const handleEmptyStateCollect = () => {
  analytics.track("gallery_import_entry", { entry: "empty_state" });
  if (isCompact.value) {
    collectSourcePicker.open();
  } else {
    collectMenuDialog.open();
  }
};

function isDefaultGalleryRoute() {
  return (
    !hasActiveGalleryFilters(galleryRouteStore.filters) &&
    galleryRouteStore.page === 1 &&
    !galleryRouteStore.search.trim()
  );
}

async function resetGalleryRouteAfterLoadError() {
  if (isDefaultGalleryRoute()) return;
  ElMessage.warning(t("gallery.galleryPathLoadFailedClearFilters"));
  await resetGalleryRouteToDefault();
}

// 桌面：选择收集方式对话框 → 本地
const onDesktopCollectLocal = () => {
  analytics.track("gallery_import_entry", { entry: "local", source: "empty_state_dialog" });
  collectMenuDialog.close();
  localImportDialog.open();
};

// 桌面：选择收集方式对话框 → 网络
const onDesktopCollectNetwork = () => {
  analytics.track("gallery_import_entry", { entry: "network", source: "empty_state_dialog" });
  collectMenuDialog.close();
  crawlerDialog.open();
};

// Android：收集方式选择器选「本地」→ MediaPicker，选「远程」→ 收集 drawer
const handleCollectSourceSelect = (source: "local" | "remote") => {
  analytics.track("gallery_import_entry", {
    entry: source === "local" ? "local" : "network",
    source: "compact_picker",
  });
  collectSourcePicker.close();
  if (source === "local") {
    mediaPicker.open();
  } else {
    crawlerDrawerStore.open();
  }
};

// 处理媒体选择器的选择事件（先关闭抽屉，再处理）
const handleMediaPickerSelect = async (
  type: "image" | "folder" | "video",
  payload?: PickFolderResult
) => {
  mediaPicker.close();
  await handleAndroidMediaSelection(type, payload);
};

// 紧凑模式下的媒体选择处理函数；选文件夹时由 MediaPicker 调 pickFolder，结果通过 payload 传入
const handleAndroidMediaSelection = async (
  type: "image" | "folder" | "video",
  folderResult?: PickFolderResult
) => {
  if (await guardDesktopOnly("picker")) return;
  try {
    if (type === 'image') {
      const uris = await pickImages();
      if (!uris || uris.length === 0) {
        return; // 用户取消或无选择
      }
      crawlerStore.addTask("local-import", undefined, {
        paths: uris,
        recursive: false,
      });
      ElMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === 'video') {
      const uris = await pickVideos();
      if (!uris || uris.length === 0) {
        return;
      }
      crawlerStore.addTask("local-import", undefined, {
        paths: uris,
        recursive: false,
      });
      ElMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === 'folder' && folderResult) {
      const folderPath = folderResult.uri ?? folderResult.path;
      if (!folderPath) return;
      crawlerStore.addTask("local-import", undefined, {
        paths: [folderPath],
        recursive: true,
      });
      ElMessage.success(t("gallery.localImportTaskAdded"));
    }
  } catch (error) {
    console.error('[Gallery] 安卓媒体选择失败:', error);
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(t("gallery.selectFailed") + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
};

// ---------- Gallery state and loading ----------
// 永久删除确认对话框相关
const removeDialog = useModal();
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);
const pendingAddToAlbumImages = ref<ImageInfo[]>([]);
// 详情/加入画册对话框已下沉到 ImageGrid
const galleryContainerRef = ref<HTMLElement | null>(null);
const galleryViewRef = ref<any>(null);
// const showAlbumDialog = ref(false);
const currentWallpaperImageId = computed<string | null>({
  get: () => settingsStore.values.currentWallpaperImageId ?? null,
  set: (value) => {
    settingsStore.values.currentWallpaperImageId = value;
  },
});
// 滚动"太快"时的俏皮提示（画廊开启）
const scrollTooFastMessages = [
  () => t("gallery.scrollTooFast1"),
  () => t("gallery.scrollTooFast2"),
  () => t("gallery.scrollTooFast3"),
  () => t("gallery.scrollTooFast4"),
  () => t("gallery.scrollTooFast5"),
];
const pickOne = (arr: (() => string)[]) => (arr[Math.floor(Math.random() * arr.length)]?.() ?? arr[0]?.() ?? "");
// 滚动超速回调（由 useImageGridAutoLoad 触发）
const onScrollOverspeed = () => {
  ElMessage({
    type: "info",
    message: pickOne(scrollTooFastMessages),
    duration: 2000,
    showClose: false,
  });
};

// 状态变量（用于 composables）
// const showSkeleton = ref(false);

// 整个页面的loading状态
const { loading, showLoading, startLoading, finishLoading } = useLoadingDelay();

const addToAlbumDialog = useModal();
const addToAlbumImageIds = ref<string[]>([]);
// TODO:
const isRefreshing = ref(false); // 刷新中状态，用于阻止刷新时 EmptyState 闪烁
// 刷新计数器，用于强制空占位符重新挂载以触发动画
const refreshKey = ref(0);
// 画廊页 Android 下不显示刷新，下拉刷新也不启用
const pullToRefreshOpts = computed(() => undefined);

// Image actions for context menu / action sheet
const imageActions = computed(() => createImageActions({ removeText: t("gallery.delete") }));

// 始终启用 images-change 监听，不管是否在前台（用于同步删除等操作）
const isGalleryActive = ref(true);

const { clearCache: clearImageMetadataCache } = useProvideImageMetadataCache();

// 使用画廊图片 composable
const {
  displayedImages,
  fetchByPath,
  refreshImagesPreserveCache,
  loadedKey,
} = useGalleryImages(
  galleryContainerRef,
  clearImageMetadataCache,
);

watch(
  () => galleryViewRef.value,
  async () => {
    await nextTick();
    galleryContainerRef.value = galleryViewRef.value?.getContainerEl?.() ?? null;
  },
  { immediate: true }
);

const pagedGallery = usePagedGallery({
  routeStore: galleryRouteStore,
  images: displayedImages,
  loadedKey,
  viewRef: galleryViewRef,
  loading: { startLoading, finishLoading },
  load: (path) => fetchByPath(path, { loadKey: path }).then(() => undefined),
  computeCountPath: () => {
    const rootPath = buildGalleryCountPath(
      galleryRouteStore.filters,
      galleryRouteStore.search
    );
    return galleryRouteStore.hide ? `hide/${rootPath}` : rootPath;
  },
  isActive: () => route.path === "/gallery" && isGalleryActive.value,
  onCountError: resetGalleryRouteAfterLoadError,
  onLoadError: async (error, path) => {
    console.error("加载路径失败:", path, error);
    await resetGalleryRouteAfterLoadError();
  },
});

const totalImagesCount = pagedGallery.totalImagesCount;
const currentPage = pagedGallery.currentPage;
const bigPageEnabled = pagedGallery.bigPageEnabled;
const loadTotalImagesCount = pagedGallery.loadTotalImagesCount;
const handleJumpToBigPage = pagedGallery.handleJumpToPage;
const handlePreviewPageBoundary = pagedGallery.handlePreviewPageBoundary;
const ensureValidGalleryPageAfterMassRemoval = pagedGallery.ensureValidPageAfterMassRemoval;

const loadImages = async (reset?: boolean) => {
  // 如果强制刷新，递增刷新计数器以触发空占位符重新挂载
  if (reset) {
    refreshKey.value++;
    startLoading();
    isRefreshing.value = true; // 标记为刷新中，阻止 EmptyState 闪烁
  }
  try {
    await refreshImagesPreserveCache(currentPath.value);
    // reset 时导航到根路径的第 1 页
    if (reset) {
      await galleryRouteStore.navigate({ filters: galleryRouteStore.filters, page: 1 });
    }
  } finally {
    finishLoading();
    isRefreshing.value = false;
  }
};

const handleManualRefresh = async () => {
  // 手动刷新：刷新画廊数据。
  analytics.track("gallery_manual_refresh");
  await loadImages(true);
  await loadTotalImagesCount();
};

// ---------- Image operations ----------
const {
  handleOpenImagePath,
  handleDownloadImage,
  handleCopyImage,
  toggleFavorite,
  setWallpaper,
  handleBatchDeleteImages,
  handleBatchHideImages,
} = useImageOperations(
  displayedImages,
  currentWallpaperImageId,
  galleryViewRef
);

const handleAddedToAlbum = async () => {
  analytics.trackAction("addToAlbum", pendingAddToAlbumImages.value);
  pendingAddToAlbumImages.value = [];
};

// 统一关闭/清理 Android 选择模式：清空选择（Grid 与 store 共用同一 ref，效果一致）
const closeSelectionMode = () => {
  if (!isCompact.value) return;
  galleryViewRef.value?.clearSelection?.();
};

const handleGridContextCommand = async (
  payload: ContextCommandPayload
): Promise<ContextCommand | null> => {
  const command = payload.command;
  const image = payload.image;
  // payload.image 来自 core ImageGrid（类型更宽松）；这里的业务操作统一以 displayedImages 中的实体为准（字段更全）。
  const imageInList =
    displayedImages.value.find((x) => x.id === image.id) ?? null;
  const selectedSet =
    "selectedImageIds" in payload && payload.selectedImageIds && payload.selectedImageIds.size > 0
      ? payload.selectedImageIds
      : new Set([image.id]);

  const isMultiSelect = selectedSet.size > 1;
  const imagesToProcess = isMultiSelect
    ? displayedImages.value.filter(img => selectedSet.has(img.id))
    : (imageInList ? [imageInList] : []);

  switch (command) {
    case "detail":
      analytics.trackAction("detail", imagesToProcess.slice(0, 1));
      return "detail";
    case "download":
      for (const img of imagesToProcess) {
        await handleDownloadImage(img);
      }
      analytics.trackAction("download", imagesToProcess);
      return null;
    case "copy":
      if (IS_WEB) {
        if (imagesToProcess[0]) await handleCopyImage(imagesToProcess[0]);
      } else if (imagesToProcess[0]) {
        await handleCopyImage(imagesToProcess[0]);
      }
      analytics.trackAction("copy", imagesToProcess.slice(0, 1));
      return null;
    case "favorite":
      if (await guardDesktopOnly("favoriteImage", { needSuper: true })) return null;
      if (imagesToProcess.length === 1) {
        // 单选：复用 composable（会同步收藏画册计数/缓存）
        await toggleFavorite(imagesToProcess[0]);
      } else if (imagesToProcess.length > 1) {
        // 多选：按“如果有任意未收藏 -> 全部收藏，否则全部取消收藏”的规则
        const desiredFavorite = imagesToProcess.some((img) => !(img.favorite ?? false));
        const toChange = imagesToProcess.filter(
          (img) => (img.favorite ?? false) !== desiredFavorite
        );
        if (toChange.length === 0) return null;

        // 为避免刷屏，这里自己批量调后端，然后对齐 gallery cache（收藏画册计数由后端+下次进入画册页兜底）
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
        if (succeededIds.length > 0) {
          const idSet = new Set(succeededIds);
          const next = displayedImages.value.map((img) =>
            idSet.has(img.id) ? ({ ...img, favorite: desiredFavorite } as ImageInfo) : img
          );
          displayedImages.value = next;
          ElMessage.success(
            desiredFavorite ? `已收藏 ${succeededIds.length} 张` : `已取消收藏 ${succeededIds.length} 张`
          );
          galleryViewRef.value?.clearSelection?.();
          analytics.trackAction(
            "favorite",
            toChange.filter((img) => succeededIds.includes(img.id)),
            { value: desiredFavorite },
          );
        }
      }
      if (imagesToProcess.length === 1) {
        analytics.trackAction("favorite", imagesToProcess);
      }
      return null;
    case "open":
      if (!isMultiSelect) {
        if (imagesToProcess[0]) await handleOpenImagePath(imagesToProcess[0].localPath);
      }
      analytics.trackAction("open", imagesToProcess.slice(0, 1));
      return null;
    case "openFolder":
      if (await guardDesktopOnly("openLocal")) return null;
      if (!isMultiSelect) {
        try {
          if (imagesToProcess[0]) {
            await invoke("open_file_folder", { filePath: imagesToProcess[0].localPath });
            analytics.trackAction("openFolder", imagesToProcess.slice(0, 1));
          }
        } catch (error) {
          console.error("打开文件夹失败:", error);
          ElMessage.error("打开文件夹失败");
        }
      }
      return null;
    case "wallpaper":
      if (imagesToProcess.length > 0) await setWallpaper(imagesToProcess);
      analytics.trackAction("wallpaper", imagesToProcess);
      return null;
    case "addToAlbum":
      addToAlbumImageIds.value = imagesToProcess.map((img) => img.id);
      pendingAddToAlbumImages.value = imagesToProcess.slice();
      addToAlbumDialog.open();
      return null;
    case "addToHidden": {
      if (await guardDesktopOnly("hideImage", { needSuper: true })) return null;
      const ids = imagesToProcess.map((img) => img.id);
      if (ids.length === 0) return null;
      const isUnhide = !!image.isHidden;
      try {
        if (isUnhide) {
          await albumStore.removeImagesFromAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(t("contextMenu.unhideSuccess"));
        } else {
          await albumStore.addImagesToAlbum(HIDDEN_ALBUM_ID, ids);
          ElMessage.success(
            ids.length > 1
              ? t("contextMenu.hiddenCount", { count: ids.length })
              : t("contextMenu.hiddenOne"),
          );
        }
        galleryViewRef.value?.clearSelection?.();
        analytics.trackAction(isUnhide ? "removeFromHidden" : "addToHidden", imagesToProcess);
      } catch (e) {
        console.error(isUnhide ? "取消隐藏失败:" : "隐藏失败:", e);
        ElMessage.error(t(isUnhide ? "contextMenu.unhideFailed" : "contextMenu.hideFailed"));
      }
      return null;
    }
    case "share":
      if (await guardDesktopOnly("share")) return null;
      if (!isMultiSelect && imagesToProcess[0]) {
        try {
          const image = imagesToProcess[0];
          const filePath = image.localPath;
          if (!filePath) {
            ElMessage.error("图片路径不存在");
            return null;
          }

          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          await loadImageTypes();
          const mimeType = getMimeTypeForImage(image, ext);
          await invoke("share_file", { filePath, mimeType });
          analytics.trackAction("share", imagesToProcess.slice(0, 1));
        } catch (error) {
          console.error("分享失败:", error);
          ElMessage.error("分享失败");
        }
      }
      return null;

    // 画廊特有：删除/移除确认对话框
    case "remove":
      // 永久删除确认对话框
      pendingRemoveImages.value = imagesToProcess;
      const count = imagesToProcess.length;
      removeDialogMessage.value = count > 1 ? t("gallery.removeFromGalleryMessageMulti", { count }) : t("gallery.removeFromGalleryMessageSingle");
      removeDialog.open();
      return null;
    case "swipe-remove" as any:
      // 上划手势：隐藏（加入隐藏画册，保留磁盘文件）
      if (imagesToProcess.length > 0) {
        void handleBatchHideImages(imagesToProcess);
        analytics.trackAction("swipe-remove", imagesToProcess);
      }
      return null;
    default:
      return null;
  }
};

// 确认移到垃圾桶
const confirmRemoveImages = async () => {
  const imagesToRemove = pendingRemoveImages.value;
  if (imagesToRemove.length === 0) {
    removeDialog.close();
    return;
  }

  removeDialog.close();
  await handleBatchDeleteImages(imagesToRemove);
  analytics.trackAction("remove", imagesToRemove);
};

// ---------- Preview flow ----------
const handleImageDoubleOpen = (payload: { action: "preview" | "open"; image: ImageInfo }) => {
  analytics.trackDoubleOpen(payload);
};

const handlePreviewNavigate = (payload: {
  direction: "prev" | "next";
  fromIndex: number;
  toIndex: number;
  wrapped: boolean;
  image: ImageInfo;
}) => {
  analytics.trackPreviewNavigate(payload);
};

const handlePreviewDetailToggle = (payload: { open: boolean; image: ImageInfo | null }) => {
  analytics.trackPreviewDetailToggle(payload);
};

const handlePreviewClose = (payload: { image: ImageInfo | null }) => {
  analytics.trackPreviewClose(payload);
};

// ---------- Event-driven refresh ----------
// 监听 CrawlerDialog 关闭，清空初始配置
watch(crawlerDialog.isOpen, (isOpen) => {
  if (!isOpen) {
    // 延迟清空，确保对话框已经处理完初始配置
    nextTick(() => {
      crawlerDialogInitialConfig.value = undefined;
    });
  }
});

const refreshGalleryPageFromEvents = async () => {
  const prevList = displayedImages.value.slice();
  // 当前壁纸被删/移除：前端清空当前选中（后端也会清空设置，这里是 UI 兜底）

  // 先更新 total（用于页码越界兜底）
  await loadTotalImagesCount();

  // 刷新"当前页"数据：不 reset，不卸载组件，只替换 images 数组引用
  await refreshImagesPreserveCache(currentPath.value, { preserveScroll: true });

  const { removedIds } = diffById(prevList, displayedImages.value);

  // 当前壁纸被删/移除：前端清空当前选中（后端也会清空设置，这里是 UI 兜底）
  if (
    currentWallpaperImageId.value &&
    removedIds.includes(currentWallpaperImageId.value)
  ) {
    currentWallpaperImageId.value = null;
  }

  // 若当前页被清空但仍有图：尽量跳转到仍可用的最大页
  if (displayedImages.value.length === 0 && totalImagesCount.value > 0) {
    await ensureValidGalleryPageAfterMassRemoval();
  }
};

useImagesChangeRefresh({
  enabled: ref(true), // 始终启用，不管是否在前台（用于同步删除等操作）
  waitMs: 1000,
  filter: (p) => {
    const reason = String(p.reason ?? "");
    const ids = Array.isArray(p.imageIds) ? p.imageIds : [];
    const intersects =
      ids.length > 0 &&
      ids.some((id) => displayedImages.value.some((img) => img.id === id));

    if (reason === "delete") {
      return ids.length === 0 || intersects;
    }
    if (reason === "change") {
      if (isWallpaperOrderBrowse.value) return true;
      return ids.length === 0 || intersects;
    }
    if (reason === "rename") {
      if (isNameBrowse.value) return true;
      return ids.length === 0 || intersects;
    }
    return true;
  },
  onRefresh: refreshGalleryPageFromEvents,
});

/** 画册成员变化：FAVORITE 就地更新星标；HIDDEN / no-album 影响 gallery 可见性，需全量刷新。 */
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    const ids = p.albumIds ?? [];
    return isNoAlbumBrowse.value || ids.includes(FAVORITE_ALBUM_ID) || ids.includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: async (p) => {
    const ids = p.albumIds ?? [];
    if (isNoAlbumBrowse.value || ids.includes(HIDDEN_ALBUM_ID)) {
      await refreshGalleryPageFromEvents();
      return;
    }
    const idSet = new Set(p.imageIds ?? []);
    if (idSet.size === 0) return;
    const fav = p.reason === "add";
    displayedImages.value = displayedImages.value.map((img) =>
      idSet.has(img.id) ? { ...img, favorite: fav } : img
    );
  },
});

// ---------- Lifecycle ----------
onMounted(async () => {
  // 注意：任务列表与运行配置在 crawler store 初始化时加载；已安装插件在 App.vue onMounted 中 loadPlugins
  loadTotalImagesCount(); // 加载总图片数

  // 如果监听器已经创建，跳过重复创建
  if (listenersCreated.value) {
    return;
  }
  listenersCreated.value = true;

  // 监听 App.vue 发送的文件拖拽事件（仅 Tauri 桌面）
  if (!IS_ANDROID && !IS_WEB) {
    const handleFileDrop = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        path: string;
        isDirectory: boolean;
        outputDir: string;
      }>;

      const { path, isDirectory, outputDir } = customEvent.detail;

      try {
        // 确保在画廊页面（App.vue 已经处理了路由跳转，这里只是双重保险）
        const currentPath = router.currentRoute.value.path;
        if (currentPath !== '/gallery') {
          await router.push({ path: "/gallery", query: { path: "全部" } });
          await nextTick();
          // 再等待一下确保组件已激活
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        crawlerStore.addTask("local-import", undefined, {
          paths: [path],
          recursive: true,
        });
        ElMessage.success(t("gallery.localImportTaskAdded"));
      } catch (error) {
        console.error('[Gallery] 处理文件拖拽事件失败:', error);
        ElMessage.error('处理文件拖拽失败: ' + (error instanceof Error ? error.message : String(error)));
      }
    };
    window.addEventListener('file-drop', handleFileDrop);
  }
});

// 组件激活时（keep-alive 缓存后重新显示）：以路由为唯一真理，始终按当前路由 path 刷新列表，保证从任务页返回后顺序与路由、header 一致。
onActivated(async () => {
  isGalleryActive.value = true;

  const pathToLoad = currentPath.value;
  if (!pathToLoad) return;

  // 列表为空时必加载；有数据时也按路由强制刷新一次，避免从任务页返回后仍显示错误顺序（路由/header 倒序但数据曾以正序加载）
  if (displayedImages.value.length === 0 || loadedKey.value !== pathToLoad) {
    try {
      await refreshImagesPreserveCache(pathToLoad);
      await loadTotalImagesCount();
    } catch (e) {
      const msg = e != null && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
      console.error("[Gallery] onActivated loadImages 失败:", pathToLoad, msg);
      throw e;
    }
  }
});

// 组件停用时（keep-alive 缓存，但不清理 Blob URL）
onDeactivated(() => {
  isGalleryActive.value = false;
  // keep-alive 缓存时不清理 Blob URL，保持图片 URL 有效
  // Android 选择模式：统一关闭并收起 bar
  if (isCompact.value) {
    closeSelectionMode();
  }
});
</script>

<style lang="scss">
.gallery-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 0;
}

.gallery-container {
  width: 100%;
  flex: 1;
  min-height: 0;
  /* 避免外层与 ImageGrid 内层双重滚动导致出现"多一条滚动条" */
  overflow: hidden;

  .gallery-content-layout {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }

  .gallery-grid-pane {
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    height: 100%;
  }

  .gallery-grid-pane > :deep(.image-grid-container) {
    height: 100%;
  }

  /* 按住空格进入“拖拽滚动模式” */
  &.drag-scroll-ready {
    cursor: grab;
  }

  /* 正在拖拽滚动 */
  &.drag-scroll-active {
    cursor: grabbing;
    user-select: none;
  }

  .load-more-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 32px 0;
    margin-top: 24px;
  }

  .context-menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }

  .context-menu {
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-light);
    border-radius: var(--el-border-radius-base);
    box-shadow: var(--el-box-shadow-light);
    padding: 4px 0;
    min-width: 120px;

    .context-menu-item {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      cursor: pointer;
      color: var(--el-text-color-primary);
      font-size: 14px;
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--el-fill-color-light);
      }

      .el-icon {
        margin-right: 8px;
      }
    }

    .context-menu-divider {
      height: 1px;
      background-color: var(--el-border-color-lighter);
      margin: 4px 0;
    }
  }

  /* 图片路径 tooltip 样式 */
  :deep(.image-path-tooltip) {
    max-width: 400px;
    padding: 8px 12px;
  }

  .tooltip-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    line-height: 1.4;
  }

  .tooltip-line {
    word-break: break-all;
    font-size: 12px;
  }

  .loading-skeleton {
    padding: 20px;
  }

  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px;
    width: 100%;
  }

  .skeleton-item {
    border: 2px solid var(--anime-border);
    border-radius: 16px;
    overflow: hidden;
    background: var(--anime-bg-card);
    box-shadow: var(--anime-shadow);
    padding: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px;
    text-align: center;

    .empty-action-btn {
      margin-top: -16px; // EmptyState 自带 padding，调整按钮位置
    }
  }

  .fade-in {
    animation: fadeIn 0.4s ease-in-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .crawl-form {
    margin-bottom: 20px;

    :deep(.el-form-item__label) {
      color: var(--anime-text-primary);
      font-weight: 500;
    }
  }

  .progress-text {
    font-size: 12px;
    color: var(--anime-text-secondary);
    margin-top: 5px;
    display: block;
    font-weight: 500;
  }

  h3 {
    color: var(--anime-text-primary);
    font-weight: 600;
    margin-bottom: 16px;
  }

  .var-description {
    font-size: 12px;
    color: #909399;
    margin-top: 4px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .plugin-option-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .plugin-option-icon-placeholder {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    color: var(--anime-text-secondary);
  }

  /* 图片预览样式 */
  .image-preview-wrapper {
    width: 100%;
    height: 100%;
    cursor: pointer;

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }

}

/* Dialog 样式需要全局作用域才能正确应用 */
</style>

<style lang="scss">
/* "开始导入图片"->"选择导入源"下拉框：下拉面板是 teleport 到 body 的，所以必须用全局样式 */
.crawl-plugin-select-dropdown {
  .el-select-dropdown__item {
    padding: 8px 12px;
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
  }

  .plugin-option-icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex-shrink: 0;
    border-radius: 4px;
  }

  .plugin-option-icon-placeholder {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    font-size: 18px;
    /* 控制 el-icon 的 svg 大小 */
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--anime-text-secondary);
  }

  .plugin-option span {
    line-height: 1.2;
    color: var(--anime-text-primary);
  }
}

.run-config-select-dropdown {
  .el-select-dropdown__item {
    padding: 6px 12px;
    min-height: 40px;
  }

  .run-config-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 32px;
    width: 100%;
  }

  .run-config-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-width: 0;
    overflow: hidden;

    .name {
      font-weight: 600;
      color: var(--el-text-color-primary);
      line-height: 1.4;
      display: flex;
      align-items: center;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      .incompatible-badge {
        color: var(--el-color-warning);
        font-weight: 600;
        margin-right: 4px;
      }

      .incompatible-reason {
        margin-top: 4px;
        font-size: 12px;
      }

      .error-text {
        color: var(--el-color-error);
      }

      .warning-text {
        color: var(--el-color-warning);
      }

      .desc {
        font-size: 12px;
        color: var(--el-text-color-secondary);
        font-weight: normal;
        margin-left: 4px;
      }
    }
  }

  .run-config-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    align-self: flex-start;
    padding-top: 2px;
  }
}

/* 图片路径 tooltip 样式 */
:deep(.image-path-tooltip) {
  max-width: 400px;
  padding: 8px 12px;
}

.tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.4;
}

.tooltip-line {
  word-break: break-all;
  font-size: 12px;
}

/* 选择收集方式对话框（teleport 到 body） */
.collect-menu-dialog .collect-menu-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.collect-menu-dialog .collect-menu-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 2px solid var(--anime-border);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.collect-menu-dialog .collect-menu-option:hover {
  border-color: var(--anime-primary);
  background: var(--el-fill-color-light);
}

.collect-menu-dialog .collect-menu-option .el-icon {
  font-size: 20px;
  color: var(--anime-primary);
}
</style>
