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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { Plus } from "@lucide/vue";
import { Button } from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import GalleryToolbar from "@/components/GalleryToolbar.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { createGalleryAdapter } from "@/components/imageGrid/adapters/gallery";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { newRandomSortSeed } from "@/utils/galleryPath";
import { IS_WEB } from "@/env";
import { createImageAnalytics } from "@/track/imageAnalytics";
import { useCollectDialogsStore } from "@/stores/collectDialogs";
import DragFileZone from "@/components/common/DragFileZone.vue";
import { buildDropPlan, importDroppedFiles } from "@/utils/dragFileImport";

// 定义组件名称，确保 keep-alive 能正确识别
defineOptions({
  name: "Gallery",
});

// ---------- Stores and route state ----------
const uiStore = useUiStore();
const { isCompact } = storeToRefs(uiStore);
const collectDialogs = useCollectDialogsStore();
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

// 空状态按钮：与页头一致，先选本地 / 网络（只有一组时直接打开）；界面由全局的 CollectEntryHost 承载
const handleEmptyStateCollect = () => {
  collectDialogs.openChooser("empty_state");
};

// ---------- 区域级文件拖入（画廊网格区域）----------
// 接受规则由 DragFileZone 的 plan prop 承载；无需页面级 computed。

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
