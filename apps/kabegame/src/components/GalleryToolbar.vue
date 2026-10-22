<template>
  <PageHeader :title="$t('gallery.gallery')" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span class="inline-flex items-center gap-2">
        <span>{{ totalCountText }}</span>
        <!-- 清除过滤挪进副标题：过滤行里那个文字按钮太占位置，而这里本来就在说
             「筛出了多少 / 一共多少」，清除是同一件事的延伸。清除简单与高级条件，
             hide 这类全局开关不算过滤，不该被这个叉号一并清掉。 -->
        <button
          v-if="isFilterIndicatorActive"
          type="button"
          class="subtitle-clear-filter"
          :title="t('gallery.clearAllFilters')"
          :aria-label="t('gallery.clearAllFilters')"
          @click="clearAllFilters"
        >
          <el-icon><Filter /></el-icon>
          <span class="subtitle-clear-filter__badge">
            <el-icon><Close /></el-icon>
          </span>
        </button>
      </span>
    </template>
  </PageHeader>

  <!-- 过滤 / 排序 / 搜索：与画册、任务、畅游详情共用同一条查询行。 -->
  <GalleryQueryBar
    ref="queryBarRef"
    :query="galleryRouteStore.query"
    :no-album="galleryRouteStore.effectiveNoAlbum"
    :sort="props.sort"
    :page-size="props.pageSize"
    :search-modes="stickySearchModes"
    :provider-context-prefix="props.providerContextPrefix"
    :context-base="galleryRouteStore.contextPathFor({ query: [] })"
    hug-top
    @navigate="onQueryNavigate"
    @search-modes-change="rememberGallerySearchModes"
  />

  <!-- 紧凑模式下 FailedImages 在 fold 菜单里，FailedImagesHeaderButton comp 不渲染，
       对话框由本组件托管并经 handleAction 打开 -->
  <Teleport v-if="uiStore.isCompact" to="body">
    <FailedImagesDialog ref="failedImagesDialogRef" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Close, Filter } from "@kabegame/element-plus-icons";
import { on, pathqlRequest$, usePathqlLooker } from "@/services/kbEvents";
import { gridTotalKey } from "@/components/imageGrid/gridTotal";
import { withGalleryPrefix } from "@/utils/path";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@/stores/header";
import { usePageBridgeStore } from "@/stores/pageBridge";
import {
  hasActiveQuery,
  querySearchTerm,
  type GalleryQuery,
  type GalleryQueryPatch,
  type GallerySort,
} from "@/utils/galleryPath";
import { useFailedImagesStore } from "@/stores/failedImages";
import {
  useGalleryRouteStore,
  galleryStickySearchModes as stickySearchModes,
  rememberGallerySearchModes,
} from "@/stores/galleryRoute";
import { storeToRefs } from "pinia";
import { useUiStore } from "@/stores/ui";
import { DEFAULT_GALLERY_PAGE_SIZE } from "@/utils/galleryPageSize";

interface Props {
  isLoadingAll?: boolean;
  bigPageEnabled?: boolean;
  /** 当前画廊过滤条件；有过滤时才显示无过滤总数（分母）。 */
  filter?: GalleryQuery;
  sort?: GallerySort;
  /** 每页条数（与设置同步，用于工具栏展示） */
  pageSize?: number;
  /** provider tree 上下文前缀：hide/search 等由 route store 统一拼好 */
  providerContextPrefix?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  bigPageEnabled: false,
  filter: () => [] as GalleryQuery,
  sort: () => ({ field: "by-id", desc: false }) as GallerySort,
  pageSize: DEFAULT_GALLERY_PAGE_SIZE,
  providerContextPrefix: "",
});

const emit = defineEmits<{
  refresh: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  showWebpageCollect: [];
  openCollectMenu: [];
}>();

const { t } = useI18n();
const uiStore = useUiStore();
const failedImagesStore = useFailedImagesStore();
const galleryRouteStore = useGalleryRouteStore();
const { hide: galleryHide } = storeToRefs(galleryRouteStore);

const queryBarRef = ref<{
  openPageSizePicker: () => void;
  refreshProviderFilterTree: () => Promise<void>;
} | null>(null);
const failedImagesDialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);

const isNoAlbumBrowse = computed(() => galleryRouteStore.effectiveNoAlbum);

/** 查询行的唯一出口：一次 patch 一次导航，搜索模式顺带记进会话记忆。 */
function onQueryNavigate(patch: GalleryQueryPatch, options?: { push?: boolean }) {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberGallerySearchModes(term.modes);
  void galleryRouteStore.navigate(patch, options);
}

// no-album 与 hide 并列，是路由上下文不是查询：天然不点亮过滤指示、不被清除。
const isFilterIndicatorActive = computed(() => hasActiveQuery(galleryRouteStore.query));

function clearAllFilters() {
  onQueryNavigate({ query: [] }, { push: true });
}

// ---------- 安卓折叠菜单标签 ----------
const failedCountFoldLabel = computed(() => {
  const n = failedImagesStore.allFailed.length;
  const suffix = n >= 99 ? "99+" : String(n);
  return `${t("header.failedImages")} (${suffix})`;
});

// ---------- 总数（分子 / 分母）----------
/**
 * 分子是 ImageGrid 注入的当前视图总数，不再单独订阅同一计数路径；分母（只带 hide 上下文的全部数量）
 * 只有工具栏用，由它自己观察。两者都落定才作为一份显示快照提交，避免独立刷新时序拼出割裂文案。
 */
const gridTotal = inject(gridTotalKey);
if (!gridTotal) throw new Error("GalleryToolbar 必须放在 ImageGrid 的插槽内");

/** 有过滤（含「无画册」）时才显示分母；无过滤时分子即全部，不读分母。 */
const denominatorKey = computed(() =>
  galleryRouteStore.effectiveNoAlbum || props.filter.length > 0
    ? withGalleryPrefix(galleryHide.value ? "hide" : "gallery")
    : null,
);
const denominator = ref<{ key: string; total: number } | null>(null);
const denominatorLooker = usePathqlLooker({
  kind: "total",
  key: () => denominatorKey.value,
  refreshOn: [on("images-change", (payload) => !!payload.reason)],
  onResult: (snapshot) => {
    if (denominatorKey.value) denominator.value = { key: denominatorKey.value, total: snapshot.total };
  },
});
// 分母路径只有工具栏在用：路径变化即请求。
watch(
  denominatorKey,
  (key) => {
    if (key) pathqlRequest$.next(["total", key]);
  },
  { immediate: true },
);

const countPair = ref<{ count: number; total: number | null } | null>(null);
watch(
  () => {
    if (!gridTotal.settled.value) return null;
    const count = gridTotal.total.value;
    const key = denominatorKey.value;
    if (!key) return { count, total: null };
    if (denominatorLooker.loading.value) return null;
    // 分母读失败时只显示分子
    if (denominatorLooker.error.value != null) return { count, total: null };
    return denominator.value?.key === key ? { count, total: denominator.value.total } : null;
  },
  (pair) => {
    if (pair) countPair.value = pair;
  },
  { immediate: true },
);

const totalCountText = computed(() => {
  const count = countPair.value?.count ?? gridTotal.total.value;
  if (count === 0) {
    return t("gallery.noImages");
  }
  const total = countPair.value?.total;
  // 没过滤(或分母还没回来)时不写 "16892 / 16892" 这种废话。
  if (total == null || total <= count) {
    return t("gallery.totalImages", { count });
  }
  return t("gallery.totalImagesFiltered", { count, total });
});

// ---------- Header ----------
const showIds = computed(() => {
  if (uiStore.isCompact) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [HeaderFeatureId.Refresh, HeaderFeatureId.FailedImages, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Collect];
});

const foldIds = computed(() => {
  if (!uiStore.isCompact) {
    return [];
  }
  // 过滤与排序和桌面一样走查询行的 chip；每页条数工具条上没有 chip，留在折叠菜单。
  return [HeaderFeatureId.FailedImages, HeaderFeatureId.GalleryPageSize];
});

const headerStore = useHeaderStore();
watch(
  [() => props.pageSize, () => failedImagesStore.allFailed.length],
  () => {
    if (!uiStore.isCompact) return;
    headerStore.setFoldLabel(HeaderFeatureId.FailedImages, failedCountFoldLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, String(props.pageSize));
  },
  { immediate: true },
);
onUnmounted(() => {
  if (!uiStore.isCompact) return;
  headerStore.setFoldLabel(HeaderFeatureId.FailedImages, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, undefined);
});

// Refresh 的入口在 header 上，这里额外注册桥接供全局快捷键（⇧⌘R）使用；
// ToggleShowHidden / ToggleShowAlbumImages 的入口在全局工具箱，只有桥接。
const pageBridge = usePageBridgeStore();
onMounted(() => {
  pageBridge.setRefresh(() => emit("refresh"));
  pageBridge.setToggleShowHidden({
    get: () => galleryHide.value,
    set: (v) => {
      galleryRouteStore.hide = v;
    },
  });
  pageBridge.setToggleShowAlbumImages({
    get: () => isNoAlbumBrowse.value,
    set: (v) => {
      onQueryNavigate({ noAlbum: v });
    },
  });
});
onUnmounted(() => {
  pageBridge.setRefresh(null);
  pageBridge.setToggleShowHidden(null);
  pageBridge.setToggleShowAlbumImages(null);
});

defineExpose({
  refreshProviderFilterTree: () => queryBarRef.value?.refreshProviderFilterTree(),
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string; value?: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.Refresh:
      emit("refresh");
      break;
    case HeaderFeatureId.Collect:
      if (payload.data.type === "openMenu") {
        emit("openCollectMenu");
      } else if (payload.data.type === "select") {
        if (payload.data.value === "local") {
          emit("showLocalImport");
        } else if (payload.data.value === "network") {
          emit("showCrawlerDialog");
        } else if (payload.data.value === "webpage") {
          emit("showWebpageCollect");
        }
      }
      break;
    case HeaderFeatureId.GalleryPageSize:
      queryBarRef.value?.openPageSizePicker();
      break;
    case HeaderFeatureId.FailedImages:
      // 桌面由 show 区的 FailedImagesHeaderButton comp 直接处理；
      // 紧凑模式走 fold 菜单 action，打开本组件托管的对话框
      failedImagesDialogRef.value?.setTaskId(undefined);
      failedImagesDialogRef.value?.open();
      break;
  }
};
</script>

<style scoped lang="scss">
/* 副标题里的清除过滤按钮：过滤图标本体 + 右上角浮出的 ✕ 徽章，
   形态沿用 chip 的清除徽章（KbFilterDropdown __clear），只是这里整颗都可点。 */
.subtitle-clear-filter {
  position: relative;
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--anime-border);
  border-radius: 7px;
  color: var(--anime-primary);
  background: var(--anime-bg-card);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;

  &:hover {
    border-color: var(--anime-primary);
    background: color-mix(in srgb, var(--anime-primary) 8%, var(--anime-bg-card));
  }
}

.subtitle-clear-filter__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  border: 2px solid var(--anime-bg-card);
  border-radius: 50%;
  color: #fff;
  background: var(--anime-primary);
  font-size: 7px;
}
</style>
