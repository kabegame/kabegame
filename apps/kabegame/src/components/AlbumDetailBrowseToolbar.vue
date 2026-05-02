<template>
  <!-- 桌面：过滤 + 排序 -->
  <div v-if="!uiStore.isCompact" class="album-detail-browse-toolbar">
    <el-dropdown trigger="click" @command="onFilterCommand">
      <el-button class="album-browse-btn">
        <el-icon class="album-browse-icon">
          <Filter />
        </el-icon>
        <span>{{ filterLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="all" :class="{ 'is-active': filterMode === 'all' }">
            {{ t("gallery.filterAll") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="wallpaper-order"
            :class="{ 'is-active': filterMode === 'wallpaper-order' }"
          >
            {{ t("gallery.filterWallpaperSet") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="image-only"
            :class="{ 'is-active': filterMode === 'image-only' }"
          >
            {{ t("gallery.filterImageOnly") }}
            <span class="album-filter-count">({{ mediaTypeCounts.imageCount }})</span>
          </el-dropdown-item>
          <el-dropdown-item
            command="video-only"
            :class="{ 'is-active': filterMode === 'video-only' }"
          >
            {{ t("gallery.filterVideoOnly") }}
            <span class="album-filter-count">({{ mediaTypeCounts.videoCount }})</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dropdown trigger="click" @command="onSortCommand">
      <el-button class="album-browse-btn">
        <el-icon class="album-browse-icon">
          <Sort />
        </el-icon>
        <span>{{ sortButtonLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu
          v-if="
            filterMode === 'all' ||
            filterMode === 'image-only' ||
            filterMode === 'video-only'
          "
        >
          <el-dropdown-item
            command="time-asc"
            :class="{ 'is-active': currentSortKey === 'time-asc' }"
          >
            {{ t("gallery.byTimeAsc") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="time-desc"
            :class="{ 'is-active': currentSortKey === 'time-desc' }"
          >
            {{ t("gallery.byTimeDesc") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="join-asc"
            :class="{ 'is-active': currentSortKey === 'join-asc' }"
          >
            {{ t("gallery.byAlbumDefaultSort") }}
          </el-dropdown-item>
        </el-dropdown-menu>
        <el-dropdown-menu v-else>
          <el-dropdown-item
            command="set-asc"
            :class="{ 'is-active': currentSortKey === 'set-asc' }"
          >
            {{ t("gallery.bySetTimeAsc") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="set-desc"
            :class="{ 'is-active': currentSortKey === 'set-desc' }"
          >
            {{ t("gallery.bySetTimeDesc") }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <GalleryPageSizeControl
      :page-size="pageSize"
      variant="album"
      android-ui="header"
      @update:page-size="(v) => emit('update:pageSize', v)"
    />

    <SearchInput
      :model-value="search ?? ''"
      :placeholder="t('gallery.searchPlaceholder')"
      class="album-browse-search"
      @update:model-value="(v) => emit('update:search', v)"
    />
  </div>

  <GalleryPageSizeControl
    v-else
    ref="pageSizeControlRef"
    :page-size="pageSize"
    variant="album"
    android-ui="header"
    @update:page-size="(v) => emit('update:pageSize', v)"
  />

  <!-- Android：fold 内点选后弹出 van-picker -->
  <Teleport v-if="uiStore.isCompact" to="body">
    <van-popup v-model:show="showFilterPicker" position="bottom" round>
      <van-picker
        v-model="filterPickerSelected"
        :title="t('gallery.filter')"
        :columns="filterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onFilterPickerConfirm"
        @cancel="showFilterPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showSortPicker" position="bottom" round>
      <van-picker
        v-model="sortPickerSelected"
        :title="sortPickerTitle"
        :columns="sortPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onSortPickerConfirm"
        @cancel="showSortPicker = false"
      />
    </van-popup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useAlbumImagesChangeRefresh } from "@/composables/useAlbumImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import { ArrowDown, Filter, Sort } from "@element-plus/icons-vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import SearchInput from "@/components/SearchInput.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import {
  buildAlbumCountPathFromCurrentPath,
  type AlbumBrowseFilter,
  type AlbumBrowseSort,
} from "@/utils/albumPath";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useAlbumDetailRouteStore } from "@/stores/albumDetailRoute";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";

const props = defineProps<{
  albumId: string;
  filter: AlbumBrowseFilter;
  sort: AlbumBrowseSort;
  /** 每页条数（与设置同步） */
  pageSize: number;
  /** display_name 搜索词 */
  search?: string;
}>();

const emit = defineEmits<{
  "update:filter": [value: AlbumBrowseFilter];
  "update:sort": [value: AlbumBrowseSort];
  "update:pageSize": [value: number];
  "update:search": [value: string];
}>();

const { t, locale } = useI18n();
const headerStore = useHeaderStore();
const uiStore = useUiStore();

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

interface ProviderCountResult {
  total?: number | null;
}

const albumId = computed(() => (props.albumId ?? "").trim());
const albumDetailRouteStore = useAlbumDetailRouteStore();

const mediaTypeCounts = ref<GalleryMediaTypeCountsPayload>({
  imageCount: 0,
  videoCount: 0,
});

async function countProviderPath(path: string): Promise<number> {
  const p = path.trim().replace(/\/+$/, "");
  if (!p) return 0;
  const res = await invoke<ProviderCountResult>("browse_gallery_provider", {
    path: p,
  });
  return typeof res?.total === "number" ? res.total : 0;
}

function countPathForFilter(id: string, filter: Extract<AlbumBrowseFilter, "image-only" | "video-only">): string {
  return buildAlbumCountPathFromCurrentPath(
    albumDetailRouteStore.computePath({
      albumId: id,
      filter,
      sort: "time-asc",
      page: 1,
      search: props.search ?? "",
    }),
  );
}

async function loadMediaTypeCounts(id: string) {
  if (!id) {
    mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
    return;
  }
  try {
    const [imageCount, videoCount] = await Promise.all([
      countProviderPath(countPathForFilter(id, "image-only")),
      countProviderPath(countPathForFilter(id, "video-only")),
    ]);
    mediaTypeCounts.value = { imageCount, videoCount };
  } catch {
    mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
  }
}

watch(
  [albumId, () => props.search ?? "", () => albumDetailRouteStore.hide],
  ([id]) => void loadMediaTypeCounts(id || ""),
  { immediate: true }
);

const filterMode = computed<AlbumBrowseFilter>(() => {
  const f = props.filter;
  if (
    f === "wallpaper-order" ||
    f === "image-only" ||
    f === "video-only" ||
    f === "all"
  ) {
    return f;
  }
  return "all";
});

const currentSortKey = computed<AlbumBrowseSort>(() => {
  return props.sort ?? "join-asc";
});

const isWallpaperFilter = computed(() => filterMode.value === "wallpaper-order");

useImagesChangeRefresh({
  enabled: computed(() => !!albumId.value),
  waitMs: 500,
  filter: (p) => {
    if (!albumId.value) return false;
    const reason = String(p.reason ?? "");
    if (reason === "delete") return true;
    if (reason === "change") return isWallpaperFilter.value;
    return false;
  },
  onRefresh: () => void loadMediaTypeCounts(albumId.value || ""),
});

useAlbumImagesChangeRefresh({
  enabled: computed(() => !!albumId.value),
  waitMs: 500,
  filter: (p) => {
    if (!albumId.value) return false;
    const ids = p.albumIds ?? [];
    return ids.includes(albumId.value) || ids.includes(HIDDEN_ALBUM_ID);
  },
  onRefresh: () => void loadMediaTypeCounts(albumId.value || ""),
});

const filterLabel = computed(() => {
  void locale.value;
  void mediaTypeCounts.value;
  if (filterMode.value === "wallpaper-order") return t("gallery.filterWallpaperSet");
  if (filterMode.value === "image-only") {
    return `${t("gallery.filterImageOnly")} (${mediaTypeCounts.value.imageCount})`;
  }
  if (filterMode.value === "video-only") {
    return `${t("gallery.filterVideoOnly")} (${mediaTypeCounts.value.videoCount})`;
  }
  return t("gallery.filterAll");
});

const sortButtonLabel = computed(() => {
  const k = currentSortKey.value;
  switch (k) {
    case "time-asc":
      return t("gallery.byTimeAsc");
    case "time-desc":
      return t("gallery.byTimeDesc");
    case "join-asc":
      return t("gallery.byAlbumDefaultSort");
    case "set-asc":
      return t("gallery.bySetTimeAsc");
    case "set-desc":
      return t("gallery.bySetTimeDesc");
    default:
      return t("gallery.byAlbumDefaultSort");
  }
});

const sortPickerTitle = computed(() =>
  isWallpaperFilter.value ||
  ((filterMode.value === "image-only" || filterMode.value === "video-only") &&
    (currentSortKey.value === "set-asc" || currentSortKey.value === "set-desc"))
    ? t("gallery.wallpaperSortTitle")
    : t("gallery.sort")
);

function onFilterCommand(cmd: string) {
  if (
    cmd !== "all" &&
    cmd !== "wallpaper-order" &&
    cmd !== "image-only" &&
    cmd !== "video-only"
  ) {
    return;
  }
  emit("update:filter", cmd as AlbumBrowseFilter);
}

const SORT_CMDS_ALL = new Set<AlbumBrowseSort>([
  "time-asc",
  "time-desc",
  "join-asc",
]);
const SORT_CMDS_WALLPAPER = new Set<AlbumBrowseSort>(["set-asc", "set-desc"]);

function onSortCommand(cmd: string) {
  const sort = cmd as AlbumBrowseSort;
  if (
    filterMode.value === "all" ||
    filterMode.value === "image-only" ||
    filterMode.value === "video-only"
  ) {
    if (!SORT_CMDS_ALL.has(sort) && !SORT_CMDS_WALLPAPER.has(sort)) return;
  } else if (!SORT_CMDS_WALLPAPER.has(sort)) {
    return;
  }
  emit("update:sort", sort);
}

// Android pickers
const showFilterPicker = ref(false);
const showSortPicker = ref(false);
useModalBack(showFilterPicker);
useModalBack(showSortPicker);

const filterPickerColumns = computed(() => {
  void locale.value;
  const ic = mediaTypeCounts.value.imageCount;
  const vc = mediaTypeCounts.value.videoCount;
  return [
    { text: t("gallery.filterAll"), value: "all" },
    { text: t("gallery.filterWallpaperSet"), value: "wallpaper-order" },
    { text: `${t("gallery.filterImageOnly")} (${ic})`, value: "image-only" },
    { text: `${t("gallery.filterVideoOnly")} (${vc})`, value: "video-only" },
  ];
});
const filterPickerSelected = ref<string[]>(["all"]);
watch(showFilterPicker, (open) => {
  if (open) {
    filterPickerSelected.value = [filterMode.value];
  }
});

function onFilterPickerConfirm() {
  showFilterPicker.value = false;
  const v = filterPickerSelected.value[0];
  if (
    v === "all" ||
    v === "wallpaper-order" ||
    v === "image-only" ||
    v === "video-only"
  ) {
    emit("update:filter", v as AlbumBrowseFilter);
  }
}

const sortPickerColumns = computed(() => {
  if (filterMode.value === "wallpaper-order") {
    return [
      { text: t("gallery.bySetTimeAsc"), value: "set-asc" },
      { text: t("gallery.bySetTimeDesc"), value: "set-desc" },
    ];
  }
  if (filterMode.value === "image-only" || filterMode.value === "video-only") {
    return [
      { text: t("gallery.byTimeAsc"), value: "time-asc" },
      { text: t("gallery.byTimeDesc"), value: "time-desc" },
      { text: t("gallery.byAlbumDefaultSort"), value: "join-asc" },
      { text: t("gallery.bySetTimeAsc"), value: "set-asc" },
      { text: t("gallery.bySetTimeDesc"), value: "set-desc" },
    ];
  }
  return [
    { text: t("gallery.byTimeAsc"), value: "time-asc" },
    { text: t("gallery.byTimeDesc"), value: "time-desc" },
    { text: t("gallery.byAlbumDefaultSort"), value: "join-asc" },
  ];
});
const sortPickerSelected = ref<string[]>(["join-asc"]);
watch(showSortPicker, (open) => {
  if (open) sortPickerSelected.value = [currentSortKey.value];
});

function onSortPickerConfirm() {
  showSortPicker.value = false;
  const v = sortPickerSelected.value[0] as AlbumBrowseSort;
  onSortCommand(v);
}

function openFilterPicker() {
  showFilterPicker.value = true;
}
function openSortPicker() {
  showSortPicker.value = true;
}

const pageSizeControlRef = ref<{ openPicker: () => void } | null>(null);
function openPageSizePicker() {
  pageSizeControlRef.value?.openPicker();
}

defineExpose({ openFilterPicker, openSortPicker, openPageSizePicker });

watch(
  [filterLabel, sortButtonLabel, () => props.pageSize],
  () => {
    if (!uiStore.isCompact) return;
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseFilter, filterLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseSort, sortButtonLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, String(props.pageSize));
  },
  { immediate: true }
);

onUnmounted(() => {
  if (!uiStore.isCompact) return;
  headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseFilter, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseSort, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, undefined);
});
</script>

<style scoped lang="scss">
.album-detail-browse-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.album-browse-btn {
  .album-browse-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}

.album-browse-search {
  margin-left: auto;
}

.album-filter-count {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
