<template>
  <div class="surf-images-page">
    <div class="surf-images-scroll-container">
      <ImageGrid
        class="surf-grid"
        :surface="surface"
        :enable-ctrl-wheel-adjust-columns="!isCompact"
        :enable-ctrl-key-adjust-columns="!isCompact"
      >
        <template #before-grid="{ totalCount, currentPage, pageSize, jumpToPage }">
          <PageHeader
            :title="recordTitle"
            :subtitle="lastVisitSubtitle"
            :show="[]"
            :fold="[HeaderFeatureId.ToggleShowHidden]"
            show-back
            sticky
            @back="goBack"
            @action="handleHeaderAction"
          />

          <div class="surf-page-size-toolbar">
            <GalleryPageSizeControl
              :page-size="pageSize"
              variant="gallery"
              android-ui="inline"
              @update:page-size="(ps) => surfImagesRouteStore.navigate({ page: 1, pageSize: ps })"
            />
          </div>

          <GalleryBigPaginator
            :total-count="totalCount"
            :current-page="currentPage"
            :big-page-size="pageSize"
            :is-sticky="true"
            @jump-to-page="jumpToPage"
          />
        </template>
      </ImageGrid>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onUnmounted, ref, computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import ImageGrid from "@/components/ImageGrid.vue";
import GalleryBigPaginator from "@/components/GalleryBigPaginator.vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import { createSurfImagesSurface } from "@/components/imageGrid/surfaces/surf";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { useSurfImagesRouteStore } from "@/stores/surfImagesRoute";
import { HeaderFeatureId, useHeaderStore } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useI18n } from "@kabegame/i18n";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { isCompact } = storeToRefs(useUiStore());
const surfStore = useSurfStore();
const surfImagesRouteStore = useSurfImagesRouteStore();
const { hide: surfHide } = storeToRefs(surfImagesRouteStore);

/** 路由与 VD 路径使用的站点 host（与 `surf_records.host` 一致） */
const surfHost = ref("");
const record = computed<SurfRecord | null>(() =>
  surfHost.value ? surfStore.recordByHost(surfHost.value) ?? null : null
);

// 数据加载 / 菜单命令 / 事件刷新均由 ImageGrid connected 模式接管
const surface = createSurfImagesSurface({
  recordId: () => record.value?.id ?? "",
});

const headerStore = useHeaderStore();
watch(
  surfHide,
  () => {
    headerStore.setFoldLabel(
      HeaderFeatureId.ToggleShowHidden,
      surfHide.value ? t("header.showHidden") : t("header.hideHidden")
    );
  },
  { immediate: true }
);
onUnmounted(() => {
  headerStore.setFoldLabel(HeaderFeatureId.ToggleShowHidden, undefined);
});

const handleHeaderAction = (payload: { id: string }) => {
  if (payload.id === HeaderFeatureId.ToggleShowHidden) {
    surfImagesRouteStore.hide = !surfImagesRouteStore.hide;
  }
};

const recordTitle = computed(() => record.value?.host ?? t("surf.surfImagesTitle"));
const lastVisitSubtitle = computed(() => {
  const r = record.value;
  if (!r?.lastVisitAt) return "";
  const date = new Date(r.lastVisitAt * 1000);
  return t("surf.lastSurfTime") + date.toLocaleString();
});

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
