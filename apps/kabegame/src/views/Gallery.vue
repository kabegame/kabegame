<template>
  <div class="gallery-page">
    <div class="gallery-container" v-pull-to-refresh="pullToRefreshOpts">
      <div class="gallery-content-layout">
        <div class="gallery-grid-pane">
          <ImageGrid
            ref="galleryViewRef"
            :surface="surface"
            :enable-ctrl-wheel-adjust-columns="!isCompact"
            hide-scrollbar
            :enable-ctrl-key-adjust-columns="!isCompact"
            :enable-virtual-scroll="true"
            :loading="isRefreshing" :loading-overlay="isRefreshing"
            scroll-whole-container>
            <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
              <!-- 顶部工具栏 -->
              <GalleryToolbar :total-count="totalCount" :big-page-enabled="totalCount > pageSize"
                :filters="galleryRouteStore.filters"
                :sort="galleryRouteStore.sort" :page-size="pageSize" :search="search"
                :provider-context-prefix="galleryRouteStore.computedContextPath"
                @refresh="handleManualRefresh" @show-help="openHelpDrawer" @show-quick-settings="openQuickSettingsDrawer"
                @show-crawler-dialog="handleShowCrawlerDialog" @show-local-import="handleShowLocalImport"
                @open-collect-menu="handleOpenCollectMenu"
                @update:filters="(filters) => galleryRouteStore.navigate({ filters, page: 1 }, { push: true })"
                @update:sort="(sort) => galleryRouteStore.navigate({ sort })"
                @update:pageSize="(ps) => galleryRouteStore.navigate({ page: 1, pageSize: ps })"
                @update:search="(s) => galleryRouteStore.navigate({ page: 1, search: s })" />

              <!-- 大页分页器 -->
              <GalleryBigPaginator :total-count="totalCount" :current-page="currentPage" :big-page-size="pageSize"
                :is-sticky="true" @jump-to-page="jumpToPage" />
            </template>

            <!-- 无图片空状态：使用 ImageGrid 的 empty 插槽（只隐藏 ImageItem，不影响 header/插槽挂载） -->
            <template #empty>
              <div v-if="!isRefreshing" :key="'empty-' + refreshKey" class="empty fade-in">
                <EmptyState />
                <el-button type="primary" class="empty-action-btn" @click="handleEmptyStateCollect">
                  <el-icon>
                    <Plus />
                  </el-icon>
                  {{ $t('gallery.startCollect') }}
                </el-button>
              </div>
            </template>
          </ImageGrid>
        </div>
      </div>
    </div>

    <!-- 收集对话框（非 Android：本地渲染；Android：由 App.vue 全局承载） -->
    <CrawlerDialog v-if="!isCompact" :model-value="crawlerDialog.isOpen.value" :initial-config="crawlerDialogInitialConfig" @update:model-value="crawlerDialog.close" />
    <LocalImportDialog v-if="!isCompact" :model-value="localImportDialog.isOpen.value" @update:model-value="localImportDialog.close" />

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
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Plus, FolderOpened, Connection } from "@element-plus/icons-vue";
import { useCrawlerStore } from "@/stores/crawler";
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
import EmptyState from "@/components/common/EmptyState.vue";
import { createGallerySurface } from "@/components/imageGrid/surfaces/gallery";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { createImageAnalytics } from "@kabegame/core/track/imageAnalytics";
import { useModal } from "@kabegame/core/composables/useModal";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
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
const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();
const { search } = storeToRefs(galleryRouteStore);

const currentPath = computed(() => galleryRouteStore.computedPath);
let lastTrackedGalleryPath: string | null = null;

// ---------- Analytics ----------
const analytics = createImageAnalytics(() => ({ path: currentPath.value }));

// 数据加载 / 菜单命令 / 事件刷新 / URL path 同步均由 ImageGrid connected 模式接管
const surface = createGallerySurface({ analytics });

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

// ---------- Gallery state ----------
const galleryViewRef = ref<InstanceType<typeof ImageGrid> | null>(null);
const isRefreshing = ref(false); // 刷新中状态，用于阻止刷新时 EmptyState 闪烁
// 刷新计数器，用于强制空占位符重新挂载以触发动画
const refreshKey = ref(0);
// 画廊页 Android 下不显示刷新，下拉刷新也不启用
const pullToRefreshOpts = computed(() => undefined);

const handleManualRefresh = async () => {
  // 手动刷新：回到第 1 页并强制重拉当前路径。
  analytics.track("gallery_manual_refresh");
  refreshKey.value++;
  isRefreshing.value = true;
  try {
    await galleryViewRef.value?.refresh({ resetScroll: true });
  } finally {
    isRefreshing.value = false;
  }
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

// ---------- Lifecycle ----------
onMounted(async () => {
  // 注意：任务列表与运行配置在 crawler store 初始化时加载；已安装插件在 App.vue onMounted 中 loadPlugins；
  // 图片列表与总数由 ImageGrid connected 模式自动加载

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

      const { path } = customEvent.detail;

      try {
        // 确保在画廊页面（App.vue 已经处理了路由跳转，这里只是双重保险）
        const currentRoutePath = router.currentRoute.value.path;
        if (currentRoutePath !== '/gallery') {
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
