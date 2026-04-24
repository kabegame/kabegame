<template>
  <div class="gallery-page">
    <div class="gallery-container" v-pull-to-refresh="pullToRefreshOpts">
      <ImageGrid ref="galleryViewRef" :images="displayedImages" :enable-ctrl-wheel-adjust-columns="!isCompact"
        hide-scrollbar :enable-ctrl-key-adjust-columns="!isCompact" :enable-virtual-scroll="!isCompact"
        :loading="loading || isRefreshing" :loading-overlay="showLoading || isRefreshing" :actions="imageActions"
        :on-context-command="handleGridContextCommand">
        <template #before-grid>
          <!-- 顶部工具栏 -->
          <GalleryToolbar :total-count="totalImagesCount" :big-page-enabled="bigPageEnabled"
            :month-options="monthOptions" :month-loading="monthOptionsLoading" :filter="galleryRouteStore.filter"
            :sort="galleryRouteStore.sort" :page-size="pageSize" :search="search" v-model:selectedRange="selectedRange"
            @refresh="handleManualRefresh" @show-help="openHelpDrawer" @show-quick-settings="openQuickSettingsDrawer"
            @show-crawler-dialog="handleShowCrawlerDialog" @show-local-import="showLocalImportDialog = true"
            @open-collect-menu="showCollectSourcePicker = true"
            @update:filter="(f) => galleryRouteStore.navigate({ filter: f, page: 1 })"
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
            <template v-if="isWallpaperOrderEmpty">
              <EmptyState :primary-tip="$t('gallery.wallpaperOrderEmptyTip')" />
              <el-button type="primary" class="empty-action-btn" @click="handleWallpaperEmptyViewAll">
                <el-icon>
                  <Picture />
                </el-icon>
                {{ $t('gallery.viewAllImages') }}
              </el-button>
            </template>
            <template v-else>
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

    <!-- 收集对话框（非 Android：本地渲染；Android：由 App.vue 全局承载） -->
    <CrawlerDialog v-if="!isCompact" v-model="showCrawlerDialog" :initial-config="crawlerDialogInitialConfig" />
    <LocalImportDialog v-if="!isCompact" v-model="showLocalImportDialog" />


    <!-- 永久删除确认对话框 -->
    <RemoveImagesConfirmDialog v-model="showRemoveDialog" :message="removeDialogMessage"
      :title="$t('gallery.confirmDelete')" hide-checkbox @confirm="confirmRemoveImages" />

    <AddToAlbumDialog v-model="showAddToAlbumDialog" :image-ids="addToAlbumImageIds" @added="handleAddedToAlbum" />

    <!-- 桌面：空状态/无下拉时用对话框选择 本地/网络 -->
    <el-dialog v-model="showCollectMenuDialog" :title="$t('gallery.chooseCollectMethod')" width="360px" destroy-on-close
      class="collect-menu-dialog">
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
    <CollectSourcePicker v-if="uiStore.isCompact" v-model="showCollectSourcePicker" @select="handleCollectSourceSelect" />
    <!-- 安卓媒体选择器（本地导入） -->
    <MediaPicker v-if="uiStore.isCompact" v-model="showMediaPicker" @select="handleMediaPickerSelect" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onActivated, onDeactivated, watch, nextTick } from "vue";
import { invoke } from "@/api/rpc";
import { useRouter, useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus, Picture, Star, StarFilled, FolderAdd, Delete, FolderOpened, Connection } from "@element-plus/icons-vue";
import { useCrawlerStore } from "@/stores/crawler";
import type { ImageInfo } from "@kabegame/core/types/image";
import { usePluginStore } from "@/stores/plugins";
import { useUiStore } from "@kabegame/core/stores/ui";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import CrawlerDialog from "@/components/CrawlerDialog.vue";
import LocalImportDialog from "@/components/LocalImportDialog.vue";
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
import type { ContextCommandPayload } from "@/components/ImageGrid.vue";
import { storeToRefs } from "pinia";
import { useImageGridAutoLoad } from "@/composables/useImageGridAutoLoad";
import { resetGalleryRouteToDefault, useGalleryRouteStore } from "@/stores/galleryRoute";
import { serializeFilter } from "@/utils/galleryPath";
import { asEntryPath } from "@/utils/path";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { diffById } from "@/utils/listDiff";
import { IS_ANDROID, IS_WINDOWS, IS_WEB } from "@kabegame/core/env";
import { clearImageStateCache } from "@kabegame/core/composables/useImageStateCache";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useProvideImageMetadataCache } from "@kabegame/core/composables/useImageMetadataCache";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import type { Component } from "vue";
import { useAlbumStore, HIDDEN_ALBUM_ID, FAVORITE_ALBUM_ID } from "@/stores/albums";
import { type ContextCommand } from "@/components/ImageGrid.vue";
import { listen } from "@/api/rpc";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";

const { t } = useI18n();
const { pluginName: resolvePluginName } = usePluginManifestI18n();

// 选择操作项类型（用于本页选择栏）
export interface SelectionAction {
  key: string;
  label: string;
  icon: Component;
  command: string;
}
import { open } from "@tauri-apps/plugin-dialog";
import MediaPicker from "@/components/MediaPicker.vue";
import CollectSourcePicker from "@/components/CollectSourcePicker.vue";
import { useImageTypes } from "@/composables/useImageTypes";
import { pickImages, pickVideos, type PickFolderResult } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

const crawlerStore = useCrawlerStore();
const crawlerDrawerStore = useCrawlerDrawerStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettingsDrawer = () => quickSettingsDrawer.open("gallery");
const helpDrawer = useHelpDrawerStore();
const openHelpDrawer = () => helpDrawer.open("gallery");
const pluginStore = usePluginStore();
const { imageGridColumns, isCompact } = storeToRefs(useUiStore());
const { extensions: imageExtensions, load: loadImageTypes, getMimeTypeForImage } = useImageTypes();
const preferOriginalInGrid = computed(() => imageGridColumns.value <= 2);

const uiStore = useUiStore();

const settingsStore = useSettingsStore();
const route = useRoute();
const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();
const { pageSize, search } = storeToRefs(galleryRouteStore);

// 是否启用分页（总数超过一页）
const bigPageEnabled = computed(() => {
  return totalImagesCount.value > pageSize.value;
});

const currentPath = computed(() => galleryRouteStore.currentPath);
const providerRootPath = computed(() => serializeFilter(galleryRouteStore.filter));
const currentPage = computed(() => galleryRouteStore.page);

const isWallpaperOrderEmpty = computed(
  () => galleryRouteStore.filter.type === "wallpaper-order"
);

const isWallpaperOrderBrowse = computed(
  () => galleryRouteStore.filter.type === "wallpaper-order"
);

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

type GalleryBrowseEntry =
  | { kind: "dir"; name: string }
  | { kind: "image"; image: ImageInfo };

type GalleryBrowseResult = {
  entries: GalleryBrowseEntry[];
  total: number | null;
  meta?: { kind: string; data: unknown } | null;
  note?: { title: string; content: string } | null;
};

const monthOptions = ref<string[]>([]);
const monthOptionsLoading = ref(false);
const selectedRange = ref<[string, string] | null>(null);

const extractRangeFromProviderRoot = (
  root: string
): [string, string] | null => {
  const segs = (root || "").split("/").map((s) => s.trim()).filter(Boolean);
  // 按时间/范围/YYYY-MM-DD~YYYY-MM-DD
  // 后端固定返回中文目录名，与 UI 语言无关
  if (segs.length >= 3 && segs[0] === "按时间" && segs[1] === "范围") {
    const raw = segs[2] ?? "";
    const parts = raw.split("~").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) return [parts[0]!, parts[1]!] as [string, string];
  }
  return null;
};

watch(
  () => [galleryRouteStore.filter, providerRootPath.value] as const,
  ([filter, root]) => {
    if (filter.type === "date-range") {
      const range: [string, string] = [filter.start, filter.end];
      if (
        !selectedRange.value ||
        selectedRange.value[0] !== range[0] ||
        selectedRange.value[1] !== range[1]
      ) {
        selectedRange.value = range;
      }
      return;
    }

    const range = extractRangeFromProviderRoot(root);
    if (range) {
      if (
        !selectedRange.value ||
        selectedRange.value[0] !== range[0] ||
        selectedRange.value[1] !== range[1]
      ) {
        selectedRange.value = range;
      }
      return;
    }

    // 不在范围路径：清空日历（但不强制改变当前 provider 路径，保持默认按月）
    if (selectedRange.value !== null) selectedRange.value = null;
  },
  { immediate: true }
);

const loadMonthOptions = async () => {
  monthOptionsLoading.value = true;
  try {
    const res = await invoke<GalleryBrowseResult>("browse_gallery_provider", {
      path: "date/",
    });
    const months = (res?.entries ?? [])
      .filter((e) => e.kind === "dir")
      .map((e) => (e as any).name as string)
      .filter(Boolean)
      .sort()
      .reverse();

    // 过滤掉范围入口（后端会额外插入“范围”目录）
    monthOptions.value = months.filter((m) => m !== "范围");
  } catch (e) {
    console.error("加载月份列表失败:", e);
  } finally {
    monthOptionsLoading.value = false;
  }
};

const listenersCreated = ref(false);
const showCrawlerDialog = ref(false);
const showLocalImportDialog = ref(false);
const showMediaPicker = ref(false);
const showCollectSourcePicker = ref(false);
const showCollectMenuDialog = ref(false);
useModalBack(showCollectMenuDialog);
const crawlerDialogInitialConfig = ref<{
  pluginId?: string;
  outputDir?: string;
  vars?: Record<string, any>;
} | undefined>(undefined);

// 桌面：打开收集（网络）对话框。Android 上由「开始收集」→ CollectSourcePicker → 远程 打开 drawer
const handleShowCrawlerDialog = () => {
  showCrawlerDialog.value = true;
};

// 空状态按钮：与工具栏一致，安卓打开「本地/远程」选择 picker，桌面打开选择对话框
const handleEmptyStateCollect = () => {
  if (isCompact.value) {
    showCollectSourcePicker.value = true;
  } else {
    showCollectMenuDialog.value = true;
  }
};

const handleWallpaperEmptyViewAll = () => {
  void galleryRouteStore.navigate({ filter: { type: "all" }, page: 1 });
};

// 桌面：选择收集方式对话框 → 本地
const onDesktopCollectLocal = () => {
  showCollectMenuDialog.value = false;
  showLocalImportDialog.value = true;
};

// 桌面：选择收集方式对话框 → 网络
const onDesktopCollectNetwork = () => {
  showCollectMenuDialog.value = false;
  showCrawlerDialog.value = true;
};

// Android：收集方式选择器选「本地」→ MediaPicker，选「远程」→ 收集 drawer
const handleCollectSourceSelect = (source: "local" | "remote") => {
  showCollectSourcePicker.value = false;
  if (source === "local") {
    showMediaPicker.value = true;
  } else {
    crawlerDrawerStore.open();
  }
};

// 处理媒体选择器的选择事件（先关闭抽屉，再处理）
const handleMediaPickerSelect = async (
  type: "image" | "folder" | "video" | "archive",
  payload?: PickFolderResult
) => {
  showMediaPicker.value = false;
  await handleAndroidMediaSelection(type, payload);
};

// 紧凑模式下的媒体选择处理函数；选文件夹时由 MediaPicker 调 pickFolder，结果通过 payload 传入
const handleAndroidMediaSelection = async (
  type: "image" | "folder" | "video" | "archive",
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
        include_archive: false,
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
        include_archive: false,
      });
      ElMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === 'archive') {
      console.log('选择压缩文件');
      // 选择压缩文件（支持 .zip、.rar、.7z、.tar、.gz、.bz2、.xz）
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: t("gallery.compressFile"),
            extensions: ['zip'],
          },
        ],
      });

      if (!selected) {
        return;
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      crawlerStore.addTask("local-import", undefined, {
        paths,
        recursive: false,
        include_archive: true,
      });
      ElMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === 'folder' && folderResult) {
      const folderPath = folderResult.uri ?? folderResult.path;
      if (!folderPath) return;
      crawlerStore.addTask("local-import", undefined, {
        paths: [folderPath],
        recursive: true,
        include_archive: false,
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
// 永久删除确认对话框相关
const showRemoveDialog = ref(false);
const removeDialogMessage = ref("");
const pendingRemoveImages = ref<ImageInfo[]>([]);
// 详情/加入画册对话框已下沉到 ImageGrid
const galleryContainerRef = ref<HTMLElement | null>(null);
const galleryViewRef = ref<any>(null);
// const showAlbumDialog = ref(false);
const currentWallpaperImageId = ref<string | null>(null);
const totalImagesCount = ref<number>(0); // 总图片数（不受过滤器影响）

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

const showAddToAlbumDialog = ref(false);
const addToAlbumImageIds = ref<string[]>([]);
// TODO:
const isRefreshing = ref(false); // 刷新中状态，用于阻止刷新时 EmptyState 闪烁
// 刷新计数器，用于强制空占位符重新挂载以触发动画
const refreshKey = ref(0);
// 画廊页 Android 下不显示刷新，下拉刷新也不启用
const pullToRefreshOpts = computed(() => undefined);

// Image actions for context menu / action sheet
const imageActions = computed(() => createImageActions({ removeText: t("gallery.delete") }));

// dragScroll 拖拽滚动期间：暂停实时 loadImageUrls，优先保证滚动帧率
const isInteracting = ref(false);
// 始终启用 images-change 监听，不管是否在前台（用于同步删除等操作）
const isGalleryActive = ref(true);
const plugins = computed(() => pluginStore.plugins);
const tasks = computed(() => crawlerStore.tasks);

// 插件配置相关的变量和函数已移至 CrawlerDialog 组件

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

const { isInteracting: autoIsInteracting } = useImageGridAutoLoad({
  containerRef: galleryContainerRef,
  onLoad: () => { },
  onOverspeed: onScrollOverspeed,
});

watch(
  () => autoIsInteracting.value,
  (v) => {
    isInteracting.value = v;
  },
  { immediate: true }
);

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
      await galleryRouteStore.navigate({ filter: galleryRouteStore.filter, page: 1 });
    }
  } finally {
    finishLoading();
    isRefreshing.value = false;
  }
};

watch(
  pageSize,
  async (_v, prev) => {
    if (prev === undefined) return;
    await loadTotalImagesCount();
    await loadImages(false);
  },
);

watch(
  () => selectedRange.value,
  async (r) => {
    if (!r || r.length !== 2) {
      return;
    }
    const start = (r[0] || "").trim();
    const end = (r[1] || "").trim();
    if (!start || !end) return;

    const nextFilter = { type: "date-range" as const, start, end };
    if (
      galleryRouteStore.filter.type === "date-range" &&
      galleryRouteStore.filter.start === start &&
      galleryRouteStore.filter.end === end
    ) {
      return;
    }

    // 切换 provider：回到第 1 页，并重载
    await galleryRouteStore.navigate({ filter: nextFilter, page: 1 });
    await loadTotalImagesCount();
    await loadImages(false);
  }
);

const handleManualRefresh = async () => {
  // 手动刷新：刷新画廊数据 + 同步刷新月份下拉框选项
  clearImageStateCache();
  await Promise.allSettled([
    loadImages(true),
    loadMonthOptions(),
  ]);
  await loadTotalImagesCount();
};


// 处理大页跳转
const handleJumpToBigPage = async (bigPage: number) => {
  startLoading();
  try {
    await galleryRouteStore.navigate({ page: bigPage });
  } finally {
    finishLoading();
  }
};

// 监听路径变化，自动加载图片。以路由为唯一真理：仅在画廊页且当前路径变化时加载，避免在任务页等误用 defaultPath 导致正序覆盖倒序。
watch(
  () => currentPath.value,
  async (newPath) => {
    if (route.path !== "/gallery") return;
    if (!isGalleryActive.value) return;
    if (!newPath) return;

    // 如果路径已加载过，跳过
    if (loadedKey.value === newPath) return;

    startLoading();
    try {
      const result = await fetchByPath(newPath, {
        loadKey: newPath,
      });
      // 同步 total 到本地
      totalImagesCount.value = result.total ?? 0;
    } catch (error) {
      console.error("加载路径失败:", newPath, error);
      if (
        galleryRouteStore.filter.type === "all" &&
        galleryRouteStore.page === 1
      ) {
        return;
      }
      await resetGalleryRouteToDefault();
    } finally {
      finishLoading();
    }
  },
  { immediate: true }
);


// 使用图片操作 composable
const {
  handleOpenImagePath,
  handleCopyImage,
  toggleFavorite,
  setWallpaper,
  exportToWallpaperEngine,
  handleBatchDeleteImages,
  handleBatchHideImages,
} = useImageOperations(
  displayedImages,
  currentWallpaperImageId,
  galleryViewRef
);

const albumStore = useAlbumStore();
const handleAddedToAlbum = async () => {
  // 画廊本身不依赖画册列表，但这里留个钩子以便其他页面/计数能及时刷新
  await albumStore.loadAlbums();
};

// getImageUrl 和 loadImageUrls 已移至 useGalleryImages composable

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin ? (resolvePluginName(plugin) || pluginId) : pluginId;
};

// 获取总图片数（随 currentPath 变化，含 filter / search / hide）
const loadTotalImagesCount = async () => {
  try {
    // 使用 provider 的无尾缀 Entry 语法：只算 composed query 的 COUNT，不触发 list_children / list_images。
    // currentPath 已由 route store 统一拼好（filter + search + hide + page），
    // COUNT SQL 忽略 LIMIT/OFFSET，所以无需单独剥离 page 段。
    const res = await invoke<{ total: number | null }>("browse_gallery_provider", {
      path: asEntryPath(galleryRouteStore.currentPath),
    });
    totalImagesCount.value = res?.total ?? 0;
  } catch (error) {
    console.error("获取总图片数失败:", error);
    if (
      galleryRouteStore.filter.type === "all" &&
      galleryRouteStore.page === 1
    ) {
      return;
    }
    await resetGalleryRouteToDefault();
  }
};

// 兜底：当去重等操作导致 total 下降，当前页码可能越界 -> 自动跳到最后一页并重载
watch(
  () => totalImagesCount.value,
  async (total) => {
    if (!bigPageEnabled.value) {
      // total <= pageSize 时只允许 page=1
      if (currentPage.value !== 1) {
        await handleJumpToBigPage(1);
      }
      return;
    }
    const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize.value));
    if (currentPage.value > totalPages) {
      await handleJumpToBigPage(totalPages);
    }
  }
);

// 去重/批量移除后：若当前页被清空，但图库仍有图，则尽量留在当前大页；
// 若当前页码越界（总页数变少），则跳转到仍可用的最大页。
let ensuringGalleryPage = false;
const ensureValidGalleryPageAfterMassRemoval = async () => {
  if (ensuringGalleryPage) return;
  ensuringGalleryPage = true;
  try {
    await loadTotalImagesCount();

    // 当前页仍有图：不处理
    if (displayedImages.value.length > 0) return;

    // 全部没图：回到根路径
    if (totalImagesCount.value <= 0) {
      await galleryRouteStore.navigate({ page: 1 });
      return;
    }

    const currentBigPage = currentPage.value;
    const totalBigPages = Math.max(
      1,
      Math.ceil(totalImagesCount.value / pageSize.value)
    );
    const targetBigPage = Math.min(currentBigPage, totalBigPages);

    await handleJumpToBigPage(targetBigPage);
  } finally {
    ensuringGalleryPage = false;
  }
};

// Android 选择模式：构建操作栏 actions
const buildSelectionActions = (selectedCount: number, selectedIds: ReadonlySet<string>): SelectionAction[] => {
  const countText = selectedCount > 1 ? `(${selectedCount})` : "";

  // 获取第一个选中图片的状态（用于判断收藏状态）
  const firstSelectedImage = displayedImages.value.find(img => selectedIds.has(img.id));
  const isFavorite = firstSelectedImage?.favorite ?? false;

  if (selectedCount === 1) {
    // 单选
    return [
      {
        key: "favorite",
        label: isFavorite ? "取消收藏" : "收藏",
        icon: isFavorite ? StarFilled : Star,
        command: "favorite",
      },
      {
        key: "addToAlbum",
        label: "加入画册",
        icon: FolderAdd,
        command: "addToAlbum",
      },
      {
        key: "remove",
        label: "删除",
        icon: Delete,
        command: "remove",
      },
    ];
  } else {
    // 多选
    return [
      {
        key: "favorite",
        label: `收藏${countText}`,
        icon: Star,
        command: "favorite",
      },
      {
        key: "addToAlbum",
        label: `加入画册${countText}`,
        icon: FolderAdd,
        command: "addToAlbum",
      },
      {
        key: "remove",
        label: `删除${countText}`,
        icon: Delete,
        command: "remove",
      },
    ];
  }
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
      return "detail";
    case "copy":
      if (IS_WEB) {
        for (const img of imagesToProcess) handleCopyImage(img);
      } else if (imagesToProcess[0]) {
        await handleCopyImage(imagesToProcess[0]);
      }
      return null;
    case "favorite":
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
        }
      }
      return null;
    case "open":
      if (!isMultiSelect) {
        if (imagesToProcess[0]) await handleOpenImagePath(imagesToProcess[0].localPath);
      }
      return null;
    case "openFolder":
      if (await guardDesktopOnly("openLocal")) return null;
      if (!isMultiSelect) {
        try {
          if (imagesToProcess[0]) {
            await invoke("open_file_folder", { filePath: imagesToProcess[0].localPath });
          }
        } catch (error) {
          console.error("打开文件夹失败:", error);
          ElMessage.error("打开文件夹失败");
        }
      }
      return null;
    case "wallpaper":
      if (await guardDesktopOnly("wallpaper")) return null;
      if (imagesToProcess.length > 0) await setWallpaper(imagesToProcess);
      return null;
    case "exportToWE":
    case "exportToWEAuto":
      if (!isMultiSelect) {
        if (imagesToProcess[0]) await exportToWallpaperEngine(imagesToProcess[0]);
      }
      return null;
    case "addToAlbum":
      addToAlbumImageIds.value = imagesToProcess.map((img) => img.id);
      showAddToAlbumDialog.value = true;
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
      showRemoveDialog.value = true;
      return null;
    case "swipe-remove" as any:
      // 上划手势：隐藏（加入隐藏画册，保留磁盘文件）
      if (imagesToProcess.length > 0) {
        void handleBatchHideImages(imagesToProcess);
      }
      return null;
    default:
      return null;
  }
};

// removeFromUiCacheByIds 已移至 useGalleryImages composable

// 确认永久删除
const confirmRemoveImages = async () => {
  const imagesToRemove = pendingRemoveImages.value;
  if (imagesToRemove.length === 0) {
    showRemoveDialog.value = false;
    return;
  }

  showRemoveDialog.value = false;
  await handleBatchDeleteImages(imagesToRemove);
};

// 监听 CrawlerDialog 关闭，清空初始配置
watch(showCrawlerDialog, (isOpen) => {
  if (!isOpen) {
    // 延迟清空，确保对话框已经处理完初始配置
    nextTick(() => {
      crawlerDialogInitialConfig.value = undefined;
    });
  }
});



// 记录已经显示过弹窗的任务ID，避免重复弹窗
const shownErrorTasks = new Set<string>();

// 监听任务状态变化，在失败时弹窗显示错误（仅作为兜底，主要通过事件触发）
watch(tasks, (newTasks, oldTasks) => {
  if (!oldTasks || oldTasks.length === 0) return;

  // 检查是否有新失败的任务
  newTasks.forEach(task => {
    const oldTask = oldTasks.find(t => t.id === task.id);
    if (oldTask && oldTask.status !== 'failed' && task.status === 'failed') {
      // 如果已经通过事件显示过弹窗，不再显示
      if (shownErrorTasks.has(task.id)) {
        return;
      }

      // 标记为已显示
      shownErrorTasks.add(task.id);

      // 任务失败，弹窗显示错误（仅作为兜底，如果事件没有触发）
      const pluginName = getPluginName(task.pluginId);

      // 如果进度为0%或错误信息包含"Script execution error"，说明脚本执行出错，使用弹窗显示详细错误信息
      if (task.progress === 0 || (task.error && task.error.includes("Script execution error"))) {
        // 使用 nextTick 确保在下一个事件循环中显示弹窗，避免阻塞
        nextTick(() => {
          ElMessage.error(
            `${pluginName} 执行失败: ${task.error || '未知错误'}`
          );
        });
      } else {
        // 其他错误使用消息提示
        ElMessage.error(`${pluginName} 执行失败: ${task.error || '未知错误'}`);
      }
    }
  });
}, { deep: true });

const refreshGalleryPageFromEvents = async () => {
  const prevList = displayedImages.value.slice();
  // 当前壁纸被删/移除：前端清空当前选中（后端也会清空设置，这里是 UI 兜底）

  // 先更新 total（用于页码越界兜底）
  await loadTotalImagesCount();

  // 刷新"当前页"数据：不 reset，不卸载组件，只替换 images 数组引用
  await refreshImagesPreserveCache(currentPath.value, { preserveScroll: true });

  const { addedIds, removedIds } = diffById(prevList, displayedImages.value);

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
    return true;
  },
  onRefresh: refreshGalleryPageFromEvents,
});

/** 画册成员变化：FAVORITE 就地更新星标；HIDDEN 全量刷新（HideGate 影响 gallery 可见性） */
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 1000,
  filter: (p) => {
    const ids = p.albumIds ?? [];
    return ids.includes(FAVORITE_ALBUM_ID) || ids.includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: async (p) => {
    const ids = p.albumIds ?? [];
    if (ids.includes(HIDDEN_ALBUM_ID)) {
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

onMounted(async () => {
  await settingsStore.loadAll();
  invoke<string | null>("get_current_wallpaper_image_id").then(id => {
    currentWallpaperImageId.value = id;
  }).catch(() => {
    currentWallpaperImageId.value = null;
  });
  // 注意：任务列表与运行配置在 crawler store 初始化时加载；已安装插件在 App.vue onMounted 中 loadPlugins
  loadTotalImagesCount(); // 加载总图片数
  loadMonthOptions(); // 加载月份下拉框选项

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
          include_archive: false,
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

// 在开发环境中监控组件更新，帮助调试重新渲染问题
// 开发期调试日志已移除，保持生产干净输出

// 组件激活时（keep-alive 缓存后重新显示）：以路由为唯一真理，始终按当前路由 path 刷新列表，保证从任务页返回后顺序与路由、header 一致。
onActivated(async () => {
  isGalleryActive.value = true;
  await settingsStore.loadAll();

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
  /* 避免外层与 ImageGrid 内层双重滚动导致出现"多一条滚动条" */
  overflow: hidden;

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
    z-index: 9998;
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
.crawl-dialog.el-dialog {
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin-top: 5vh !important;
  margin-bottom: 5vh !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
    padding: 20px 20px 10px !important;
    border-bottom: 1px solid var(--anime-border);
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    padding: 20px !important;
    min-height: 0 !important;
    max-height: none !important;
  }

  .el-dialog__footer {
    flex-shrink: 0 !important;
    padding: 10px 20px 20px !important;
    border-top: 1px solid var(--anime-border);
  }
}

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
