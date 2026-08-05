<template>
  <PageHeader :title="$t('gallery.gallery')" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span class="inline-flex items-center gap-2">
        <span>{{ totalCountText }}</span>
        <!-- 清除过滤挪进副标题：过滤行里那个文字按钮太占位置，而这里本来就在说
             「筛出了多少 / 一共多少」，清除是同一件事的延伸。只认简单过滤 + 搜索,
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
          <span class="subtitle-clear-filter__badge"><el-icon><Close /></el-icon></span>
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
    :page="galleryRouteStore.page"
    :page-size="props.pageSize"
    :search-mode="stickySearchMode"
    :provider-context-prefix="props.providerContextPrefix"
    :context-base="galleryRouteStore.contextPathFor({ query: [] })"
    hug-top
    @navigate="onQueryNavigate"
    @search-mode-change="rememberGallerySearchMode"
  />

  <!-- 紧凑模式下 FailedImages 在 fold 菜单里，FailedImagesHeaderButton comp 不渲染，
       对话框由本组件托管并经 handleAction 打开 -->
  <Teleport v-if="uiStore.isCompact" to="body">
    <FailedImagesDialog ref="failedImagesDialogRef" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh, type AlbumImagesChangePayload } from "@/composables/useAlbumImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import { Close, Filter } from "@kabegame/element-plus-icons";
import { pathqlEntry } from "@/services/pathql";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import { withGalleryPrefix } from "@/utils/path";
import FailedImagesDialog from "@/components/FailedImagesDialog.vue";
import GalleryQueryBar from "@/components/gallery/GalleryQueryBar.vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { usePageBridgeStore } from "@/stores/pageBridge";
import {
  asSingleFilterSet,
  filterSetToSingleFilter,
  hasActiveQuery,
  querySearchTerm,
  type GalleryQueryPatch,
  type GallerySort,
} from "@/utils/galleryPath";
import {
  galleryLabelForFilter,
  gallerySortOrderLabels,
} from "@/utils/galleryFilterLabels";
import { usePluginStore } from "@/stores/plugins";
import { useFailedImagesStore } from "@/stores/failedImages";
import {
  useGalleryRouteStore,
  galleryStickySearchMode as stickySearchMode,
  rememberGallerySearchMode,
} from "@/stores/galleryRoute";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  sort?: GallerySort;
  /** 每页条数（与设置同步，用于工具栏展示） */
  pageSize?: number;
  /** provider tree 上下文前缀：hide/search 等由 route store 统一拼好 */
  providerContextPrefix?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  sort: () => ({ field: "by-id", desc: false } as GallerySort),
  pageSize: 100,
  providerContextPrefix: "",
});

const emit = defineEmits<{
  refresh: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  openCollectMenu: [];
}>();

const { t, locale } = useI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const galleryRouteStore = useGalleryRouteStore();
const { hide: galleryHide } = storeToRefs(galleryRouteStore);

const queryBarRef = ref<{
  openFilterPicker: () => void;
  openSortPicker: () => void;
  openPageSizePicker: () => void;
  refreshProviderFilterTree: () => Promise<void>;
} | null>(null);
const failedImagesDialogRef = ref<InstanceType<typeof FailedImagesDialog> | null>(null);

/** 查询的单原子投影（安卓折叠菜单标签用）；null = 组合查询。 */
const simpleFilters = computed(() => asSingleFilterSet(galleryRouteStore.query));
const isNoAlbumBrowse = computed(() => galleryRouteStore.effectiveNoAlbum);

/** 查询行的唯一出口：一次 patch 一次导航，搜索模式顺带记进会话记忆。 */
function onQueryNavigate(patch: GalleryQueryPatch, options?: { push?: boolean }) {
  const term = patch.query ? querySearchTerm(patch.query) : null;
  if (term?.query.trim()) rememberGallerySearchMode(term.mode);
  void galleryRouteStore.navigate(patch, options);
}

// no-album 与 hide 并列，是路由上下文不是查询：天然不点亮过滤指示、不被清除。
const isFilterIndicatorActive = computed(() =>
  hasActiveQuery(galleryRouteStore.query)
);

function clearAllFilters() {
  onQueryNavigate({ query: [], page: 1 }, { push: true });
}

// ---------- 安卓折叠菜单标签 ----------
const labelContext = computed(() => ({
  t,
  locale: String(locale.value),
  pluginLabel: (id: string) => pluginStore.pluginLabel(id),
}));

const filterFoldLabel = computed(() =>
  galleryLabelForFilter(
    filterSetToSingleFilter(simpleFilters.value ?? {}),
    labelContext.value,
  ),
);

const sortFoldLabel = computed(() => {
  const labels = gallerySortOrderLabels(props.sort.field, t);
  return props.sort.desc ? labels.desc : labels.asc;
});

// 组合查询没有单一维度标签，折叠菜单里不展示过滤入口。
const showGalleryFilterFold = computed(() => simpleFilters.value !== null);

const failedCountFoldLabel = computed(() => {
  const n = failedImagesStore.allFailed.length;
  const suffix = n >= 99 ? "99+" : String(n);
  return `${t("header.failedImages")} (${suffix})`;
});

// ---------- 总数（分子 / 分母）----------
/**
 * 无过滤总数（分母）。只带上下文里那部分「不是用户过滤」的东西——目前就是 hide，
 * 所以它跟着 galleryHide 与入库变更自己刷新，不依赖当前这次查询的结果。
 */
const unfilteredTotal = ref<number | null>(null);

async function refreshUnfilteredTotal() {
  try {
    const res = await pathqlEntry(withGalleryPrefix(galleryHide.value ? "hide" : "gallery"));
    unfilteredTotal.value = typeof res?.total === "number" ? res.total : null;
  } catch {
    unfilteredTotal.value = null; // 拿不到就退回只显示当前数，不显示分母
  }
}

watch(galleryHide, () => void refreshUnfilteredTotal(), { immediate: true });

useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 500,
  onRefresh: refreshUnfilteredTotal,
});

// 隐藏/取消隐藏走 album_images 而不是 images：只订阅前者的话，藏掉一张图后
// 分子会掉、分母不动，副标题就长期停在 "16876 / 16877" 这种差一。
useAlbumImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 500,
  filter: (payload: AlbumImagesChangePayload) =>
    (payload.albumIds ?? []).includes(HIDDEN_ALBUM_ID),
  onRefresh: refreshUnfilteredTotal,
});

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return t("gallery.noImages");
  }
  const total = unfilteredTotal.value;
  // 没过滤(或分母还没回来)时不写 "16892 / 16892" 这种废话。
  if (total == null || total <= props.totalCount) {
    return t("gallery.totalImages", { count: props.totalCount });
  }
  return t("gallery.totalImagesFiltered", { count: props.totalCount, total });
});

// ---------- Header ----------
const showIds = computed(() => {
  if (uiStore.isCompact) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [
    HeaderFeatureId.FailedImages,
    HeaderFeatureId.TaskDrawer,
    HeaderFeatureId.Collect,
  ];
});

const foldIds = computed(() => {
  if (!uiStore.isCompact) {
    return [];
  }
  const ids: HeaderFeatureId[] = [HeaderFeatureId.FailedImages];
  if (showGalleryFilterFold.value) {
    ids.push(HeaderFeatureId.GalleryFilter);
  }
  ids.push(HeaderFeatureId.GallerySort);
  ids.push(HeaderFeatureId.GalleryPageSize);
  return ids;
});

const headerStore = useHeaderStore();
watch(
  [
    sortFoldLabel,
    filterFoldLabel,
    showGalleryFilterFold,
    () => props.pageSize,
    () => failedImagesStore.allFailed.length,
  ],
  () => {
    if (!uiStore.isCompact) return;
    headerStore.setFoldLabel(HeaderFeatureId.FailedImages, failedCountFoldLabel.value);
    if (showGalleryFilterFold.value) {
      headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, filterFoldLabel.value);
    } else {
      headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, undefined);
    }
    headerStore.setFoldLabel(HeaderFeatureId.GallerySort, sortFoldLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, String(props.pageSize));
  },
  { immediate: true },
);
onUnmounted(() => {
  if (!uiStore.isCompact) return;
  headerStore.setFoldLabel(HeaderFeatureId.FailedImages, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GallerySort, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, undefined);
});

// Refresh / ToggleShowHidden / ToggleShowAlbumImages 入口已收进全局工具箱，这里只注册桥接。
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
      onQueryNavigate({ noAlbum: v, page: 1 });
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
    case HeaderFeatureId.Collect:
      if (payload.data.type === "openMenu") {
        emit("openCollectMenu");
      } else if (payload.data.type === "select") {
        if (payload.data.value === "local") {
          emit("showLocalImport");
        } else if (payload.data.value === "network") {
          emit("showCrawlerDialog");
        }
      }
      break;
    case HeaderFeatureId.GalleryFilter:
      queryBarRef.value?.openFilterPicker();
      break;
    case HeaderFeatureId.GallerySort:
      queryBarRef.value?.openSortPicker();
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
  transition: border-color 0.18s ease, background-color 0.18s ease;

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
