<template>
  <div class="gallery-page">
    <div class="gallery-container" v-pull-to-refresh="pullToRefreshOpts">
      <div class="gallery-content-layout">
        <DragFileZone
          class="gallery-grid-pane"
          :plan="(items) => buildDropPlan(items, null)"
          :on-drop="(plan) => importDroppedFiles(plan, null)"
        >
          <ImageGrid
            ref="galleryViewRef"
            :adapter="adapter"
            :enable-ctrl-wheel-adjust-columns="!isCompact"
            hide-scrollbar
            :enable-ctrl-key-adjust-columns="!isCompact"
            :enable-virtual-scroll="true"
            :loading="isRefreshing"
            :loading-overlay="isRefreshing"
            scroll-whole-container
          >
            <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
              <!-- 顶部工具栏 -->
              <GalleryToolbar
                :big-page-enabled="totalCount > pageSize"
                :sort="galleryRouteStore.sort"
                :page-size="pageSize"
                :provider-context-prefix="galleryRouteStore.computedContextPath"
                @refresh="handleManualRefresh"
                @show-crawler-dialog="handleShowCrawlerDialog"
                @show-local-import="handleShowLocalImport"
                @show-webpage-collect="handleShowWebpageCollect"
                @show-wallpaper-import="handleShowWallpaperImport"
                @open-collect-menu="handleOpenCollectMenu"
              />

              <!-- 大页分页器 -->
              <GalleryBigPaginator
                :total-count="totalCount"
                :current-page="currentPage"
                :big-page-size="pageSize"
                :is-sticky="true"
                @jump-to-page="jumpToPage"
              />
            </template>

            <!-- 无图片空状态：使用 ImageGrid 的 empty 插槽（只隐藏 ImageItem，不影响 header/插槽挂载） -->
            <template #empty>
              <div v-if="!isRefreshing" :key="'empty-' + refreshKey" class="empty fade-in">
                <EmptyState />
                <Button variant="primary" class="-mt-4" @click="handleEmptyStateCollect">
                  <Plus />
                  {{ $t("gallery.startCollect") }}
                </Button>
              </div>
            </template>
          </ImageGrid>
        </DragFileZone>
      </div>
    </div>

    <!-- 收集弹窗由 App.vue 全局唯一承载；本页只走 crawlerDrawerStore.open() -->
    <LocalImportDialog
      v-if="!isCompact && !IS_WEB"
      :model-value="localImportDialog.isOpen.value"
      @update:model-value="localImportDialog.close"
    />
    <!-- 网页收集：桌面 dialog / 紧凑 drawer 由组件自身切换；Web 发布版不开放（避免服务端 SSRF） -->
    <WebpageCollectDialog
      v-if="!IS_WEB"
      :model-value="webpageCollectDialog.isOpen.value"
      @update:model-value="webpageCollectDialog.close"
    />
    <!-- 壁纸（Wallpaper Engine）：仅桌面端开放 -->
    <WallpaperImportDialog
      v-if="!IS_WEB && !IS_ANDROID"
      :model-value="wallpaperImportDialog.isOpen.value"
      @update:model-value="wallpaperImportDialog.close"
    />

    <!-- 桌面：空状态/无下拉时用对话框选择 本地/网络 -->
    <Dialog
      :open="collectMenuDialog.isOpen.value"
      :title="$t('gallery.chooseCollectMethod')"
      :width="360"
      @update:open="(v: boolean) => !v && collectMenuDialog.close()"
    >
      <div class="flex flex-col gap-2">
        <button
          v-for="item in collectMenuItems"
          :key="item.key"
          type="button"
          class="box-border flex w-full cursor-pointer items-center gap-3 rounded-kb-lg border border-solid border-kb-line-strong bg-transparent px-3.5 py-3 text-left [font:inherit] text-[13.5px] font-500 text-kb-fg outline-none transition-[background-color,border-color] duration-150 hover:border-kb-fg-subtle hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring"
          @click="item.run"
        >
          <span
            class="grid size-9 shrink-0 place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-[18px]"
          >
            <component :is="item.icon" />
          </span>
          {{ item.label }}
        </button>
      </div>
    </Dialog>

    <!-- Android：收集方式选择器（本地 → MediaPicker，远程 → 收集 drawer） -->
    <CollectSourcePicker
      v-if="uiStore.isCompact"
      :model-value="collectSourcePicker.isOpen.value"
      @update:model-value="collectSourcePicker.close"
      @select="handleCollectSourceSelect"
    />
    <!-- 安卓媒体选择器（本地导入） -->
    <MediaPicker
      v-if="uiStore.isCompact && !IS_WEB"
      :model-value="mediaPicker.isOpen.value"
      @update:model-value="mediaPicker.close"
      @select="handleMediaPickerSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { kameMessage } from "@/utils/kameMessage";
import { FolderOpen, Globe, Link2, Monitor, Plus } from "@lucide/vue";
import { Button, Dialog } from "@/components/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { useUiStore } from "@/stores/ui";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import LocalImportDialog from "@/components/LocalImportDialog.vue";
import WebpageCollectDialog from "@/components/WebpageCollectDialog.vue";
import WallpaperImportDialog from "@/components/WallpaperImportDialog.vue";
import MediaPicker from "@/components/MediaPicker.vue";
import CollectSourcePicker from "@/components/CollectSourcePicker.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { createGalleryAdapter } from "@/components/imageGrid/adapters/gallery";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { newRandomSortSeed } from "@/utils/galleryPath";
import { IS_ANDROID, IS_WEB } from "@/env";
import { createImageAnalytics } from "@/track/imageAnalytics";
import { useModal } from "@/composables/useModal";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { pickImages, pickVideos, type PickFolderResult } from "tauri-plugin-picker-api";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useI18n } from "@kabegame/i18n";
import DragFileZone from "@/components/common/DragFileZone.vue";
import { buildDropPlan, importDroppedFiles } from "@/utils/dragFileImport";

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
const router = useRouter();
const galleryRouteStore = useGalleryRouteStore();

const currentPath = computed(() => galleryRouteStore.computedPath);
let lastTrackedGalleryPath: string | null = null;

// ---------- Analytics ----------
const analytics = createImageAnalytics(() => ({ path: currentPath.value }));

// 数据加载 / 菜单命令 / 事件刷新 / URL path 同步均由 ImageGrid connected 模式接管
const adapter = createGalleryAdapter({ analytics });

watch(
  currentPath,
  (path) => {
    if (!IS_WEB) return;
    if (!path) return;
    if (path === lastTrackedGalleryPath) return;
    lastTrackedGalleryPath = path;
    analytics.track("gallery_path");
  },
  { immediate: true },
);

// ---------- Dialog and import flow ----------
const listenersCreated = ref(false);
const localImportDialog = useModal();
const webpageCollectDialog = useModal();
const wallpaperImportDialog = useModal();
const mediaPicker = useModal();
const collectSourcePicker = useModal();
const collectMenuDialog = useModal();

// 打开收集弹窗（网络）：不写 taskConfig，直接打开——自然是上次的值或空表单
const handleShowCrawlerDialog = () => {
  analytics.track("gallery_import_entry", { entry: "network" });
  crawlerDrawerStore.open();
};

const handleShowLocalImport = () => {
  if (IS_WEB) return;
  analytics.track("gallery_import_entry", { entry: "local" });
  localImportDialog.open();
};

const handleShowWebpageCollect = () => {
  if (IS_WEB) return;
  analytics.track("gallery_import_entry", { entry: "webpage" });
  webpageCollectDialog.open();
};

const handleShowWallpaperImport = () => {
  if (IS_WEB || IS_ANDROID) return;
  analytics.track("gallery_import_entry", { entry: "wallpaper" });
  wallpaperImportDialog.open();
};

const handleOpenCollectMenu = () => {
  analytics.track("gallery_import_entry", { entry: "collect_menu" });
  collectSourcePicker.open();
};

// ---------- 区域级文件拖入（画廊网格区域）----------
// 接受规则由 DragFileZone 的 plan prop 承载；无需页面级 computed。

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
  if (IS_WEB) return;
  analytics.track("gallery_import_entry", { entry: "local", source: "empty_state_dialog" });
  collectMenuDialog.close();
  localImportDialog.open();
};

// 桌面：选择收集方式对话框 → 网络
const onDesktopCollectNetwork = () => {
  analytics.track("gallery_import_entry", { entry: "network", source: "empty_state_dialog" });
  collectMenuDialog.close();
  crawlerDrawerStore.open();
};

// 桌面：选择收集方式对话框 → 网页（先关选择层，再开独立表单）
const onDesktopCollectWebpage = () => {
  if (IS_WEB) return;
  analytics.track("gallery_import_entry", { entry: "webpage", source: "empty_state_dialog" });
  collectMenuDialog.close();
  webpageCollectDialog.open();
};

// 桌面：选择收集方式对话框 → 壁纸（Wallpaper Engine）
const onDesktopCollectWallpaper = () => {
  if (IS_WEB || IS_ANDROID) return;
  analytics.track("gallery_import_entry", { entry: "wallpaper", source: "empty_state_dialog" });
  collectMenuDialog.close();
  wallpaperImportDialog.open();
};

/** 选择收集方式对话框的选项（Web 只有网络；Android 没有壁纸） */
const collectMenuItems = computed(() =>
  [
    { key: "local", show: !IS_WEB, icon: FolderOpen, label: t("gallery.local"), run: onDesktopCollectLocal },
    { key: "network", show: true, icon: Globe, label: t("gallery.network"), run: onDesktopCollectNetwork },
    { key: "webpage", show: !IS_WEB, icon: Link2, label: t("gallery.webpage"), run: onDesktopCollectWebpage },
    {
      key: "wallpaper",
      show: !IS_WEB && !IS_ANDROID,
      icon: Monitor,
      label: t("gallery.wallpaper"),
      run: onDesktopCollectWallpaper,
    },
  ].filter((item) => item.show),
);

// 紧凑布局：收集方式选择器选「本地」→ MediaPicker，「远程」→ 收集 drawer，「网页」→ 网页收集 drawer
const handleCollectSourceSelect = (source: "local" | "remote" | "webpage" | "wallpaper") => {
  analytics.track("gallery_import_entry", {
    entry: source === "local" ? "local" : source === "webpage" ? "webpage" : "network",
    source: "compact_picker",
  });
  collectSourcePicker.close();
  if (source === "local") {
    if (IS_WEB) return;
    mediaPicker.open();
  } else if (source === "webpage") {
    if (IS_WEB) return;
    webpageCollectDialog.open();
  } else if (source === "wallpaper") {
    if (IS_WEB || IS_ANDROID) return;
    wallpaperImportDialog.open();
  } else {
    crawlerDrawerStore.open();
  }
};

// 处理媒体选择器的选择事件（先关闭抽屉，再处理）
const handleMediaPickerSelect = async (type: "image" | "folder" | "video", payload?: PickFolderResult) => {
  mediaPicker.close();
  await handleAndroidMediaSelection(type, payload);
};

// 紧凑模式下的媒体选择处理函数；选文件夹时由 MediaPicker 调 pickFolder，结果通过 payload 传入
const handleAndroidMediaSelection = async (type: "image" | "folder" | "video", folderResult?: PickFolderResult) => {
  if (await guardDesktopOnly("picker")) return;
  try {
    if (type === "image") {
      const uris = await pickImages();
      if (!uris || uris.length === 0) {
        return; // 用户取消或无选择
      }
      crawlerStore.addTask("local-import", undefined, {
        paths: uris,
        recursive: false,
      });
      kameMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === "video") {
      const uris = await pickVideos();
      if (!uris || uris.length === 0) {
        return;
      }
      crawlerStore.addTask("local-import", undefined, {
        paths: uris,
        recursive: false,
      });
      kameMessage.success(t("gallery.localImportTaskAdded"));
    } else if (type === "folder" && folderResult) {
      const folderPath = folderResult.uri ?? folderResult.path;
      if (!folderPath) return;
      crawlerStore.addTask("local-import", undefined, {
        paths: [folderPath],
        recursive: true,
      });
      kameMessage.success(t("gallery.localImportTaskAdded"));
    }
  } catch (error) {
    console.error("[Gallery] 安卓媒体选择失败:", error);
    if (error !== "cancel" && error !== "close") {
      kameMessage.error(t("gallery.selectFailed") + ": " + (error instanceof Error ? error.message : String(error)));
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
  // 手动刷新：强制重拉当前路径。
  analytics.track("gallery_manual_refresh");
  refreshKey.value++;
  if (galleryRouteStore.sort.field === "random") {
    // 随机排序下手动刷新 = 重新洗牌：换 seed 即换 path，
    // ImageGrid 的 path watcher（usePagedGallery）会据此自动重拉一次；
    // 这里不再调用 galleryViewRef.refresh()，避免对同一次刷新重复拉两次。
    await galleryRouteStore.navigate({
      sort: { ...galleryRouteStore.sort, seed: newRandomSortSeed() },
    });
    return;
  }
  isRefreshing.value = true;
  galleryViewRef.value?.refresh({ resetScroll: true });
  // 请求即返回；没有发出请求（路径未就绪）时直接收起
  if (!galleryViewRef.value?.loading) isRefreshing.value = false;
};
// 刷新结果经观察方落地：最新请求结束即收起
watch(
  () => galleryViewRef.value?.loading,
  (loading) => {
    if (!loading) isRefreshing.value = false;
  },
);

// ---------- Event-driven refresh ----------

// ---------- Lifecycle ----------
onMounted(async () => {
  // 注意：任务列表与运行配置在 crawler store 初始化时加载；已安装插件在 App.vue onMounted 中 loadPlugins；
  // 图片列表与总数由 ImageGrid connected 模式自动加载

  // 如果监听器已经创建，跳过重复创建
  if (listenersCreated.value) {
    return;
  }
  listenersCreated.value = true;
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

  .load-more-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 32px 0;
    margin-top: 24px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px;
    text-align: center;
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
}
</style>
