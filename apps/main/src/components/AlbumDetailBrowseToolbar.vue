<template>
  <!-- 桌面：过滤 + 排序 -->
  <div v-if="!IS_ANDROID" class="album-detail-browse-toolbar">
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
            {{ t("gallery.byAlbumJoinAsc") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="join-desc"
            :class="{ 'is-active': currentSortKey === 'join-desc' }"
          >
            {{ t("gallery.byAlbumJoinDesc") }}
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
    />
  </div>

  <GalleryPageSizeControl
    v-else
    ref="pageSizeControlRef"
    :page-size="pageSize"
    variant="album"
    android-ui="header"
  />

  <!-- Android：fold 内点选后弹出 van-picker -->
  <Teleport v-if="IS_ANDROID" to="body">
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
import { useI18n } from "@kabegame/i18n";
import { useRoute, useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, Filter, Sort } from "@element-plus/icons-vue";
import GalleryPageSizeControl from "@/components/GalleryPageSizeControl.vue";
import { IS_ANDROID } from "@kabegame/core/env";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import {
  albumBrowsePathWithFilterOnly,
  albumBrowsePathWithSortOnly,
  parseAlbumBrowsePath,
  type AlbumBrowseFilter,
  type AlbumBrowseSort,
} from "@/utils/albumPath";

const props = defineProps<{
  /** 当前完整 provider path，如 album/xxx/1 */
  currentProviderPath: string;
  /** 每页条数（与设置同步） */
  pageSize: number;
}>();

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const headerStore = useHeaderStore();

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

const parsed = computed(() => parseAlbumBrowsePath(props.currentProviderPath.trim()));

const albumId = computed(() => (parsed.value?.albumId ?? "").trim());

const mediaTypeCounts = ref<GalleryMediaTypeCountsPayload>({
  imageCount: 0,
  videoCount: 0,
});

watch(
  albumId,
  async (id) => {
    if (!id) {
      mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
      return;
    }
    try {
      const mt = await invoke<GalleryMediaTypeCountsPayload>("get_album_media_type_counts", {
        albumId: id,
      });
      if (mt && typeof mt.imageCount === "number" && typeof mt.videoCount === "number") {
        mediaTypeCounts.value = {
          imageCount: mt.imageCount,
          videoCount: mt.videoCount,
        };
      }
    } catch {
      mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
    }
  },
  { immediate: true }
);

const filterMode = computed<AlbumBrowseFilter>(() => {
  const f = parsed.value?.filter;
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
  const s = parsed.value?.sort;
  if (s) return s;
  return "time-asc";
});

const isWallpaperFilter = computed(() => filterMode.value === "wallpaper-order");

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
      return t("gallery.byAlbumJoinAsc");
    case "join-desc":
      return t("gallery.byAlbumJoinDesc");
    case "set-asc":
      return t("gallery.bySetTimeAsc");
    case "set-desc":
      return t("gallery.bySetTimeDesc");
    default:
      return t("gallery.byTimeAsc");
  }
});

const sortPickerTitle = computed(() =>
  isWallpaperFilter.value ||
  ((filterMode.value === "image-only" || filterMode.value === "video-only") &&
    (currentSortKey.value === "set-asc" || currentSortKey.value === "set-desc"))
    ? t("gallery.wallpaperSortTitle")
    : t("gallery.sort")
);

async function pushPath(nextPath: string) {
  await router.replace({
    path: route.path,
    query: { ...route.query, path: nextPath },
  });
}

function onFilterCommand(cmd: string) {
  const path = props.currentProviderPath.trim();
  if (
    cmd !== "all" &&
    cmd !== "wallpaper-order" &&
    cmd !== "image-only" &&
    cmd !== "video-only"
  ) {
    return;
  }
  void pushPath(albumBrowsePathWithFilterOnly(path, cmd as AlbumBrowseFilter));
}

const SORT_CMDS_ALL = new Set<AlbumBrowseSort>([
  "time-asc",
  "time-desc",
  "join-asc",
  "join-desc",
]);
const SORT_CMDS_WALLPAPER = new Set<AlbumBrowseSort>(["set-asc", "set-desc"]);

function onSortCommand(cmd: string) {
  const path = props.currentProviderPath.trim();
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
  void pushPath(albumBrowsePathWithSortOnly(path, sort));
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
    void pushPath(
      albumBrowsePathWithFilterOnly(props.currentProviderPath.trim(), v as AlbumBrowseFilter)
    );
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
      { text: t("gallery.byAlbumJoinAsc"), value: "join-asc" },
      { text: t("gallery.byAlbumJoinDesc"), value: "join-desc" },
      { text: t("gallery.bySetTimeAsc"), value: "set-asc" },
      { text: t("gallery.bySetTimeDesc"), value: "set-desc" },
    ];
  }
  return [
    { text: t("gallery.byTimeAsc"), value: "time-asc" },
    { text: t("gallery.byTimeDesc"), value: "time-desc" },
    { text: t("gallery.byAlbumJoinAsc"), value: "join-asc" },
    { text: t("gallery.byAlbumJoinDesc"), value: "join-desc" },
  ];
});
const sortPickerSelected = ref<string[]>(["time-asc"]);
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
    if (!IS_ANDROID) return;
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseFilter, filterLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseSort, sortButtonLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, String(props.pageSize));
  },
  { immediate: true }
);

onUnmounted(() => {
  if (!IS_ANDROID) return;
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

.album-filter-count {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
