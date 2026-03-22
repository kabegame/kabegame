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
        <el-dropdown-menu v-if="filterMode === 'all'">
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
  </div>

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
import { ArrowDown, Filter, Sort } from "@element-plus/icons-vue";
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
}>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const headerStore = useHeaderStore();

const parsed = computed(() => parseAlbumBrowsePath(props.currentProviderPath.trim()));

const filterMode = computed<AlbumBrowseFilter>(() =>
  parsed.value?.filter === "wallpaper-order" ? "wallpaper-order" : "all"
);

const currentSortKey = computed<AlbumBrowseSort>(() => {
  const s = parsed.value?.sort;
  if (s) return s;
  return "time-asc";
});

const isWallpaperFilter = computed(() => filterMode.value === "wallpaper-order");

const filterLabel = computed(() =>
  isWallpaperFilter.value ? t("gallery.filterWallpaperSet") : t("gallery.filterAll")
);

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
  isWallpaperFilter.value ? t("gallery.wallpaperSortTitle") : t("gallery.sort")
);

async function pushPath(nextPath: string) {
  await router.replace({
    path: route.path,
    query: { ...route.query, path: nextPath },
  });
}

function onFilterCommand(cmd: string) {
  const path = props.currentProviderPath.trim();
  if (cmd !== "all" && cmd !== "wallpaper-order") return;
  void pushPath(albumBrowsePathWithFilterOnly(path, cmd));
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
  if (filterMode.value === "all") {
    if (!SORT_CMDS_ALL.has(sort)) return;
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

const filterPickerColumns = computed(() => [
  { text: t("gallery.filterAll"), value: "all" },
  { text: t("gallery.filterWallpaperSet"), value: "wallpaper-order" },
]);
const filterPickerSelected = ref<string[]>(["all"]);
watch(showFilterPicker, (open) => {
  if (open) {
    filterPickerSelected.value = [filterMode.value];
  }
});

function onFilterPickerConfirm() {
  showFilterPicker.value = false;
  const v = filterPickerSelected.value[0];
  if (v === "all" || v === "wallpaper-order") {
    void pushPath(albumBrowsePathWithFilterOnly(props.currentProviderPath.trim(), v));
  }
}

const sortPickerColumns = computed(() => {
  if (filterMode.value === "wallpaper-order") {
    return [
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

defineExpose({ openFilterPicker, openSortPicker });

watch(
  [filterLabel, sortButtonLabel],
  () => {
    if (!IS_ANDROID) return;
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseFilter, filterLabel.value);
    headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseSort, sortButtonLabel.value);
  },
  { immediate: true }
);

onUnmounted(() => {
  if (!IS_ANDROID) return;
  headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseFilter, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.AlbumBrowseSort, undefined);
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
</style>
