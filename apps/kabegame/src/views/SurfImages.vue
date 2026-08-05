<template>
  <div class="surf-images-page">
    <div class="surf-images-scroll-container">
      <ImageGrid
        class="surf-grid"
        :surface="surface"
        :enable-ctrl-wheel-adjust-columns="!isCompact"
        :enable-ctrl-key-adjust-columns="!isCompact"
        hide-scrollbar
        scroll-whole-container
      >
        <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
          <PageHeader
            :title="recordTitle"
            :subtitle="totalCountSubtitle(totalCount)"
            :show="[]"
            :fold="[]"
            show-back
            sticky
            @back="goBack"
          />

          <GalleryQueryBar
            :query="surfImagesRouteStore.query"
            :no-album="surfImagesRouteStore.effectiveNoAlbum"
            :sort="surfImagesRouteStore.sort"
            :page="surfImagesRouteStore.page"
            :page-size="pageSize"
            :search-mode="surfImagesStickySearchMode"
            :provider-context-prefix="surfImagesRouteStore.computedContextPath"
            :context-base="surfImagesRouteStore.contextPathFor({ query: [] })"
            :filter-features="surfFilterFeatures"
            :sort-features="surfSortFeatures"
            :search-features="surfSearchFeatures"
            enable-clear-all
            @navigate="onQueryNavigate"
            @search-mode-change="rememberSurfImagesSearchMode"
          />

          <GalleryBigPaginator
            :total-count="totalCount"
            :current-page="currentPage"
            :big-page-size="pageSize"
            :is-sticky="true"
            @jump-to-page="jumpToPage"
          />
        </template>

        <template #empty>
          <div class="surf-empty fade-in">
            <EmptyState :lines="[t('surf.surfImagesEmptyTip')]" show-button :button-text="t('surf.openSurf')"
              @button-click="handleOpenSurf" />
          </div>
        </template>
      </ImageGrid>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted, onUnmounted, ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import { createSurfImagesSurface } from "@/components/imageGrid/surfaces/surf";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import {
  useSurfImagesRouteStore,
  rememberSurfImagesSearchMode,
  surfImagesStickySearchMode,
} from "@/stores/surfImagesRoute";
import {
  GALLERY_SEARCH_MODES_BASIC,
  querySearchTerm,
  type GalleryBrowseDimension,
  type GalleryQueryPatch,
  type GallerySortField,
} from "@/utils/galleryPath";
import { usePageBridgeStore } from "@/stores/pageBridge";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { isCompact } = storeToRefs(useUiStore());
const surfStore = useSurfStore();
const surfImagesRouteStore = useSurfImagesRouteStore();

const surfFilterFeatures: GalleryBrowseDimension[] = [
  "plugin", "mediaType", "date", "size", "aspect",
];
const surfSortFeatures: GallerySortField[] = [
  "by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time",
];
const surfSearchFeatures = GALLERY_SEARCH_MODES_BASIC;

/** 查询行的唯一出口：一次 patch 一次导航，搜索模式顺带记进会话记忆。 */
const onQueryNavigate = (patch: GalleryQueryPatch, options?: { push?: boolean }) => {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberSurfImagesSearchMode(term.mode);
  void surfImagesRouteStore.navigate(patch, options);
};

/** 路由与 VD 路径使用的站点 host（与 `surf_records.host` 一致） */
const surfHost = ref("");
const record = computed<SurfRecord | null>(() =>
  surfHost.value ? surfStore.recordByHost(surfHost.value) ?? null : null
);

// 数据加载 / 菜单命令 / 事件刷新均由 ImageGrid connected 模式接管
const surface = createSurfImagesSurface({
  recordId: () => record.value?.id ?? "",
});

// 「显示隐藏图片」入口与画廊/任务详情一致收进全局工具箱，这里只注册桥接。
const pageBridge = usePageBridgeStore();
onMounted(() => {
  pageBridge.setToggleShowHidden({
    get: () => surfImagesRouteStore.hide,
    set: (v) => {
      surfImagesRouteStore.hide = v;
    },
  });
});
onUnmounted(() => {
  pageBridge.setToggleShowHidden(null);
});

// 与畅游列表/详情一致：优先展示用户起的名字，没起过才退回 host
const recordTitle = computed(
  () => record.value?.name || record.value?.host || t("surf.surfImagesTitle")
);

/**
 * 副标题只给总图片数，与画册详情页一致——直接复用 ImageGrid 已经算好的 totalCount，
 * 不额外查询。文案共用 `albums.totalCountSubtitle`，避免两份相同副本各自漂移。
 */
const totalCountSubtitle = (totalCount: number) =>
  totalCount ? t("albums.totalCountSubtitle", { count: totalCount }) : "";

const initRecord = async (host: string) => {
  surfHost.value = host;
  await surfStore.init();
  const r = await surfStore.ensureRecordByHost(host);
  if (!r) {
    goBack();
    return;
  }
  await surfImagesRouteStore.patch({ host, page: 1 });
  // 列表与总数由 ImageGrid 按 currentPath 变化自动加载
};

const goBack = () => {
  router.push("/surf");
};

const handleOpenSurf = async () => {
  const r = record.value;
  if (!r) return;
  try {
    await surfStore.startSession(r.rootUrl);
    ElMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

const isOnSurfImagesRoute = computed(() => String(route.name ?? "") === "SurfImages");

// keep-alive: 监听路由参数变化
watch(
  () => route.params.host,
  async (newHost) => {
    if (!isOnSurfImagesRoute.value) return;
    if (newHost && typeof newHost === "string" && newHost !== surfHost.value) {
      await initRecord(newHost);
    }
  },
  { immediate: true }
);

watch(record, (next, prev) => {
  if (!surfHost.value || next || !prev) return;
  goBack();
});

onActivated(async () => {
  const host = String(route.params.host || "");
  if (host && host !== surfHost.value) {
    await initRecord(host);
  }
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
  overflow: hidden;
  padding: 20px;
}

.surf-grid {
  flex: 1;
  min-height: 0;
}

.surf-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 16px;
}

</style>
