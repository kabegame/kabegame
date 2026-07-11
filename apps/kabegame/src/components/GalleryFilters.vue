<template>
  <div class="gallery-filters w-full min-w-0">
    <!-- 桌面：过滤/排序/pageSize/搜索行 -->
    <div v-if="!uiStore.isCompact" class="flex flex-wrap items-center gap-2 mb-2">
      <!-- 打开过滤行按钮 -->
      <div v-if="filterFeatures.length > 0" class="relative inline-flex max-w-[280px]">
        <el-button
          class="max-w-[280px] !pr-7"
          :class="{
            '!border-[rgba(255,107,157,0.55)] !bg-[rgba(255,107,157,0.12)] !text-[var(--anime-primary)] !shadow-[0_0_0_1px_rgba(255,107,157,0.20)]': isFilterIndicatorActive,
          }"
          @click="showDesktopFilterRow = !showDesktopFilterRow"
        >
          <el-icon class="mr-1.5 text-sm">
            <Filter />
          </el-icon>
          <span>{{ t("gallery.filter") }}</span>
          <el-icon
            class="el-icon--right transition-transform duration-150 ease-[ease]"
            :class="{ 'rotate-180': showDesktopFilterRow }"
          >
            <ArrowDown />
          </el-icon>
        </el-button>
        <button
          v-if="isFilterIndicatorActive"
          type="button"
          class="absolute -right-1 -top-1 z-10 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white bg-[var(--anime-primary)] p-0 text-[11px] text-white shadow-[0_2px_6px_rgba(255,107,157,0.35)] cursor-pointer"
          :aria-label="t('gallery.clearAllFilters')"
          :title="t('gallery.clearAllFilters')"
          @click.stop.prevent="clearAllFilters"
        >
          <el-icon>
            <Close />
          </el-icon>
        </button>
      </div>

      <!-- 排序维度 -->
      <el-dropdown v-if="sortFeatures.length > 0" trigger="click" @command="onDesktopSortFieldCommand">
        <el-button class="max-w-[280px]">
          <el-icon class="mr-1.5 text-sm">
            <Sort />
          </el-icon>
          <span>{{ sortFieldLabel(sortField) }}</span>
          <el-icon class="el-icon--right transition-transform duration-150 ease-[ease]">
            <ArrowDown />
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="field in sortFeatures"
              :key="field"
              :command="field"
              :class="{ 'is-active': sortField === field }"
            >
              {{ sortFieldLabel(field) }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <!-- 排序方向 -->
      <el-button v-if="sortFeatures.length > 0" class="max-w-[280px]" @click="toggleDesktopSortDesc">
        <el-icon
          class="mr-1.5 text-sm transition-transform duration-150 ease-[ease]"
          :class="{ 'rotate-180': sortOrder === 'desc' }"
        >
          <Sort />
        </el-icon>
        <span>{{ sortOrder === "desc" ? t("gallery.sortDescending") : t("gallery.sortAscending") }}</span>
      </el-button>

      <!-- 页面大小 -->
      <el-dropdown v-if="enablePageSize" trigger="click" @command="onDesktopPageSizeCommand">
        <el-button class="max-w-[280px]">
          <el-icon class="mr-1.5 text-sm">
            <Histogram />
          </el-icon>
          <span>{{ pageSizeLabel }}</span>
          <el-icon class="el-icon--right transition-transform duration-150 ease-[ease]">
            <ArrowDown />
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="n in pageSizeOptions"
              :key="n"
              :command="String(n)"
              :class="{ 'is-active': pageSize === n }"
            >
              {{ n }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <button
        v-if="enableRefresh"
        type="button"
        class="el-button el-button--default max-w-[280px]"
        @click="emit('refresh')"
      >
        <el-icon class="mr-1.5 text-sm">
          <Refresh />
        </el-icon>
        <span>{{ t("header.refresh") }}</span>
      </button>

      <SearchInput
        v-if="enableSearch"
        :model-value="search"
        :placeholder="t('gallery.searchPlaceholder')"
        class="ml-auto"
        @update:model-value="(v) => emit('update:search', v)"
      />
    </div>

    <!-- 桌面具体过滤行 -->
    <div v-if="!uiStore.isCompact && showDesktopFilterRow && filterFeatures.length > 0" class="flex flex-wrap items-center gap-2 mb-2">
      <div
        v-for="dimension in filterDimensions"
        :key="dimension.key"
        class="relative inline-flex items-center max-w-[260px]"
      >
        <el-popover
          :visible="!!dimensionPopoverOpen[dimension.key]"
          placement="bottom-start"
          trigger="click"
          width="auto"
          @update:visible="setDimensionPopoverOpen(dimension.key, $event)"
        >
          <template #reference>
            <div class="relative inline-flex max-w-[240px]">
              <el-button
                class="max-w-[240px] !pr-7 [&_span]:min-w-0"
                :class="{
                  '!border-[rgba(255,107,157,0.55)] !bg-[rgba(255,107,157,0.12)] !text-[var(--anime-primary)] !shadow-[0_0_0_1px_rgba(255,107,157,0.20)]': isDimensionActive(dimension.key),
                }"
                :aria-label="dimension.title"
                :title="dimension.title"
              >
                <el-icon
                  class="mr-1.5 flex-none text-sm text-[var(--anime-text-secondary)]"
                  :class="{ '!text-[var(--anime-primary)]': isDimensionActive(dimension.key) }"
                >
                  <component :is="dimension.icon" />
                </el-icon>
                <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {{ dimensionLabel(dimension.key) }}
                </span>
                <el-icon class="el-icon--right transition-transform duration-150 ease-[ease]">
                  <ArrowDown />
                </el-icon>
              </el-button>
              <button
                v-if="isDimensionActive(dimension.key)"
                type="button"
                class="absolute -right-1 -top-1 z-10 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white bg-[var(--anime-primary)] p-0 text-[11px] text-white shadow-[0_2px_6px_rgba(255,107,157,0.35)] cursor-pointer"
                :aria-label="`${dimension.title}: ${t('gallery.filterAny')}`"
                @click.stop.prevent="clearDimension(dimension.key)"
              >
                <el-icon>
                  <Close />
                </el-icon>
              </button>
            </div>
          </template>
          <div class="w-[320px] max-w-[min(320px,80vw)]">
            <button
              type="button"
              class="w-[calc(100%-12px)] m-[6px] min-h-8 border-0 rounded-[6px] bg-transparent text-[var(--anime-text-primary)] text-left px-3 cursor-pointer hover:bg-[var(--el-fill-color-light)]"
              :class="{
                '!bg-[rgba(255,107,157,0.14)] !text-[var(--anime-primary)]': !isDimensionActive(dimension.key),
              }"
              @click="clearDimension(dimension.key)"
            >
              {{ t("gallery.filterAny") }}
            </button>
            <GalleryFilterTree
              ref="providerTreeRef"
              :context-prefix="providerContextPrefix"
              :filters="activeFilters"
              :filter="filterForDimension(activeFilters, dimension.key)"
              :dimension="dimension.key"
              :visible="!!dimensionPopoverOpen[dimension.key]"
              @update:filter="(f) => onDimensionFilter(dimension.key, f)"
            />
          </div>
        </el-popover>
      </div>
    </div>

    <!-- Android：fold 中「过滤」「排序」弹出的 van-picker -->
    <Teleport v-if="uiStore.isCompact" to="body">
      <van-popup :show="filterPicker.isOpen.value" position="bottom" round :z-index="filterPicker.zIndex.value" @update:show="filterPicker.close">
        <van-picker
          v-model="filterPickerSelected"
          :title="$t('gallery.filter')"
          :columns="filterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onFilterPickerConfirm"
          @cancel="filterPicker.close()"
        />
      </van-popup>
      <van-popup :show="timeFilterPicker.isOpen.value" position="bottom" round :z-index="timeFilterPicker.zIndex.value" @update:show="timeFilterPicker.close">
        <van-picker
          v-model="timeFilterPickerSelected"
          :title="timeFilterPickerTitle"
          :columns="timeFilterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onTimeFilterPickerConfirm"
          @change="onTimeFilterPickerChange"
          @cancel="timeFilterPicker.close()"
        />
      </van-popup>
      <van-popup :show="pluginFilterPicker.isOpen.value" position="bottom" round :z-index="pluginFilterPicker.zIndex.value" @update:show="pluginFilterPicker.close">
        <van-picker
          v-model="pluginFilterPickerSelected"
          :title="t('gallery.filterByPlugin')"
          :columns="pluginFilterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onPluginFilterPickerConfirm"
          @cancel="pluginFilterPicker.close()"
        />
      </van-popup>
      <van-popup :show="mediaTypeFilterPicker.isOpen.value" position="bottom" round :z-index="mediaTypeFilterPicker.zIndex.value" @update:show="mediaTypeFilterPicker.close">
        <van-picker
          v-model="mediaTypeFilterPickerSelected"
          :title="t('gallery.filterByMediaType')"
          :columns="mediaTypeFilterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onMediaTypeFilterPickerConfirm"
          @cancel="mediaTypeFilterPicker.close()"
        />
      </van-popup>
      <van-popup :show="nameFilterPicker.isOpen.value" position="bottom" round :z-index="nameFilterPicker.zIndex.value" @update:show="nameFilterPicker.close">
        <van-picker
          v-model="nameFilterPickerSelected"
          :title="t('gallery.filterByName')"
          :columns="nameFilterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onNameFilterPickerConfirm"
          @cancel="nameFilterPicker.close()"
        />
      </van-popup>
      <van-popup :show="aspectFilterPicker.isOpen.value" position="bottom" round :z-index="aspectFilterPicker.zIndex.value" @update:show="aspectFilterPicker.close">
        <van-picker
          v-model="aspectFilterPickerSelected"
          :title="t('gallery.filterByAspect')"
          :columns="aspectFilterPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onAspectFilterPickerConfirm"
          @cancel="aspectFilterPicker.close()"
        />
      </van-popup>
      <van-popup v-if="sortFeatures.length > 0" :show="sortPicker.isOpen.value" position="bottom" round :z-index="sortPicker.zIndex.value" @update:show="sortPicker.close">
        <van-picker
          v-model="sortPickerSelected"
          :title="$t('gallery.byTime')"
          :columns="sortPickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onSortPickerConfirm"
          @cancel="sortPicker.close()"
        />
      </van-popup>
      <van-popup v-if="enablePageSize" :show="pageSizePicker.isOpen.value" position="bottom" round :z-index="pageSizePicker.zIndex.value" @update:show="pageSizePicker.close">
        <van-picker
          v-model="pageSizePickerSelected"
          :title="$t('gallery.pageSize')"
          :columns="pageSizePickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onPageSizePickerConfirm"
          @cancel="pageSizePicker.close()"
        />
      </van-popup>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, ref, watch, onUnmounted, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  ArrowDown,
  Calendar,
  Close,
  CollectionTag,
  Connection,
  Files,
  Film,
  Filter,
  Histogram,
  Refresh,
  ScaleToOriginal,
  Search,
  Sort,
} from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import { pathqlEntry, pathqlList } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";
import SearchInput from "@/components/SearchInput.vue";
import GalleryFilterTree from "@/components/galleryFilterTree/GalleryFilterTree.vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import {
  GALLERY_ASPECT_BUCKETS,
  GALLERY_NAME_LANGUAGE_BUCKETS,
  filterForDimension,
  filterAspectRange,
  filterDateSegment,
  filterMediaFormat,
  filterMediaKind,
  filterNameBucket,
  filterNoAlbum,
  filterPluginId,
  filterSizeRange,
  filterSetToSingleFilter,
  hasActiveGalleryFilters,
  removeFilterDimension,
  serializeFilterSet,
  setFilterDimension,
  singleFilterToSet,
  type GalleryFilter,
  type GalleryFilterDimension,
  type GalleryFilterSet,
  type GallerySort,
  type GallerySortField,
} from "@/utils/galleryPath";
import {
  buildGalleryTimeMenuTree,
  buildTimeMenuScopeLabels,
  formatTimeFilterDetail,
  getTimeMenuMaxDepth,
  resolveInitialTimePickPath,
  resolveTimeMenuPickToDateTail,
  syncTimeMenuPickerState,
  type DateGroupRow,
  type DayGroupRow,
  type TimeMenuNode,
  type YearGroupRow,
} from "@/utils/galleryTimeFilterMenu";
import { usePluginStore } from "@/stores/plugins";

interface Props {
  filters?: GalleryFilterSet;
  filter?: GalleryFilter;
  sort?: GallerySort;
  pageSize?: number;
  search?: string;
  providerContextPrefix?: string;
  filterFeatures?: GalleryFilterDimension[];
  sortFeatures?: GallerySortField[];
  enableSearch?: boolean;
  enablePageSize?: boolean;
  enableRefresh?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  filters: () => ({} as GalleryFilterSet),
  filter: () => ({ type: "all" } as GalleryFilter),
  sort: () => ({ field: "by-time", desc: false } as GallerySort),
  pageSize: 100,
  search: "",
  providerContextPrefix: "",
  filterFeatures: () => [],
  sortFeatures: () => [],
  enableSearch: false,
  enablePageSize: false,
  enableRefresh: false,
});

const emit = defineEmits<{
  "update:filters": [value: GalleryFilterSet];
  "update:filter": [value: GalleryFilter];
  "update:sort": [value: GallerySort];
  "update:pageSize": [value: number];
  "update:search": [value: string];
  refresh: [];
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const uiStore = useUiStore();

const activeFilters = computed<GalleryFilterSet>(() => props.filters ?? singleFilterToSet(props.filter));
const sortField = computed<GallerySortField>(() => props.sort.field);
const sortOrder = computed<"asc" | "desc">(() => (props.sort.desc ? "desc" : "asc"));

const SIZE_RANGE_LABEL_KEYS: Record<string, string> = {
  "unknown": "filterSize_unknown",
  "1B-512KB": "filterSize_lt512k",
  "512KB-1MB": "filterSize_512k_1m",
  "1MB-2MB": "filterSize_1m_2m",
  "2MB-5MB": "filterSize_2m_5m",
  "5MB-10MB": "filterSize_5m_10m",
  "10MB-50MB": "filterSize_10m_50m",
  "50MB-": "filterSize_gte50m",
};

const ASPECT_RANGE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  GALLERY_ASPECT_BUCKETS.map((b) => [b.range, b.labelKey]),
);
const NAME_BUCKET_AUTONYMS: Record<string, string> = Object.fromEntries(
  GALLERY_NAME_LANGUAGE_BUCKETS.map((b) => [b.bucket, b.autonym]),
);

const showDesktopFilterRow = ref(false);
const dimensionPopoverOpen = ref<Partial<Record<GalleryFilterDimension, boolean>>>({});

const FILTER_DIMENSION_ICONS: Record<Exclude<GalleryFilterDimension, "noAlbum">, Component> = {
  wallpaperOrder: markRaw(CollectionTag),
  plugin: markRaw(Connection),
  mediaType: markRaw(Film),
  date: markRaw(Calendar),
  name: markRaw(Search),
  size: markRaw(Files),
  aspect: markRaw(ScaleToOriginal),
};

const filterDimensions = computed<Array<{
  key: GalleryFilterDimension;
  title: string;
  icon: Component;
}>>(() => {
  const allDimensions: Array<{
    key: GalleryFilterDimension;
    titleKey: string;
    icon: Component;
  }> = [
    { key: "date", titleKey: "gallery.filterByTime", icon: FILTER_DIMENSION_ICONS.date },
    { key: "plugin", titleKey: "gallery.filterByPlugin", icon: FILTER_DIMENSION_ICONS.plugin },
    { key: "mediaType", titleKey: "gallery.filterByMediaType", icon: FILTER_DIMENSION_ICONS.mediaType },
    { key: "aspect", titleKey: "gallery.filterByAspect", icon: FILTER_DIMENSION_ICONS.aspect },
    { key: "size", titleKey: "gallery.filterBySize", icon: FILTER_DIMENSION_ICONS.size },
    { key: "name", titleKey: "gallery.filterByName", icon: FILTER_DIMENSION_ICONS.name },
    { key: "wallpaperOrder", titleKey: "gallery.filterWallpaperSet", icon: FILTER_DIMENSION_ICONS.wallpaperOrder },
  ];
  return allDimensions
    .filter((d) => props.filterFeatures.includes(d.key))
    .map((d) => ({ key: d.key, title: t(d.titleKey), icon: d.icon }));
});

const isFilterIndicatorActive = computed(
  () =>
    !!props.search.trim() ||
    hasActiveGalleryFilters(activeFilters.value)
);

function sortFieldLabel(field: GallerySortField) {
  switch (field) {
    case "by-id":
      return t("gallery.sortByDefault");
    case "by-time":
      return t("gallery.sortByTime");
    case "by-size":
      return t("gallery.sortBySize");
    case "by-name":
      return t("gallery.sortByName");
    case "by-aspect":
      return t("gallery.sortByAspect");
    case "by-set-time":
      return t("gallery.sortBySetTime");
    case "by-album-order":
      return t("gallery.byAlbumDefaultSort");
  }
}

function setDimensionPopoverOpen(dimension: GalleryFilterDimension, open: boolean) {
  dimensionPopoverOpen.value = { ...dimensionPopoverOpen.value, [dimension]: open };
}

function closeDimensionPopover(dimension: GalleryFilterDimension) {
  setDimensionPopoverOpen(dimension, false);
}

function isDimensionActive(dimension: GalleryFilterDimension) {
  return filterForDimension(activeFilters.value, dimension).type !== "all";
}

function clearDimension(dimension: GalleryFilterDimension) {
  emit("update:filters", removeFilterDimension(activeFilters.value, dimension));
  closeDimensionPopover(dimension);
}

function clearAllFilters() {
  emit("update:filters", {});
  emit("update:search", "");
  dimensionPopoverOpen.value = {};
}

function onDimensionFilter(dimension: GalleryFilterDimension, filter: GalleryFilter) {
  emit("update:filters", setFilterDimension(activeFilters.value, dimension, filter));
  closeDimensionPopover(dimension);
}

function onDesktopSortFieldCommand(cmd: string) {
  if (!props.sortFeatures.includes(cmd as GallerySortField)) return;
  emit("update:sort", { ...props.sort, field: cmd as GallerySortField });
}

function toggleDesktopSortDesc() {
  emit("update:sort", { ...props.sort, desc: !props.sort.desc });
}

function dimensionLabel(dimension: GalleryFilterDimension) {
  const filter = filterForDimension(activeFilters.value, dimension);
  return filter.type === "all" ? t("gallery.filterAny") : labelForFilter(filter);
}

function labelForFilter(filter: GalleryFilter) {
  void locale.value;
  if (filter.type === "wallpaper-order") return t("gallery.filterWallpaperSet");
  if (filter.type === "no-album") return t("gallery.filterNoAlbum");
  const nb = filterNameBucket(filter);
  if (nb !== null) {
    const detail = NAME_BUCKET_AUTONYMS[nb] ?? nb;
    return `${t("gallery.filterByName")}: ${detail}`;
  }
  const sr = filterSizeRange(filter);
  if (sr !== null) {
    const key = SIZE_RANGE_LABEL_KEYS[sr];
    const detail = key ? t(`gallery.${key}`) : sr;
    return `${t("gallery.filterBySize")}: ${detail}`;
  }
  const ar = filterAspectRange(filter);
  if (ar !== null) {
    const key = ASPECT_RANGE_LABEL_KEYS[ar];
    const detail = key ? t(`gallery.${key}`) : ar;
    return `${t("gallery.filterByAspect")}: ${detail}`;
  }
  if (filter.type === "date-range") {
    return `${filter.start} ~ ${filter.end}`;
  }
  const dt = filterDateSegment(filter);
  if (dt) {
    return t("gallery.filterByTimeWithDetail", {
      detail: formatTimeFilterDetail(dt, String(locale.value), t),
    });
  }
  const pid = filterPluginId(filter);
  if (pid) {
    const ext = filter.type === "plugin" ? filter.extendPath?.trim() : "";
    const name = pluginStore.pluginLabel(pid);
    return ext ? `${name} / ${ext}` : t("gallery.filterByPluginWithName", { name });
  }
  const mk = filterMediaKind(filter);
  const mf = filterMediaFormat(filter);
  if (mk === "image") {
    const label = t("gallery.filterImageOnlyLabel");
    if (mf) return `${label} / ${mf}`;
    return isLazyLoaded("media-type") ? `${label} (${mediaTypeCounts.value.imageCount})` : label;
  }
  if (mk === "video") {
    const label = t("gallery.filterVideoOnlyLabel");
    if (mf) return `${label} / ${mf}`;
    return isLazyLoaded("media-type") ? `${label} (${mediaTypeCounts.value.videoCount})` : label;
  }
  return t("gallery.filterAll");
}

const pageSizeOptions = [100, 500, 1000] as const;
const pageSizeLabel = computed(() => String(props.pageSize));

function onDesktopPageSizeCommand(cmd: string) {
  const n = Number(cmd);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  emit("update:pageSize", n);
}

const providerTreeRef = ref<any>(null);

defineExpose({
  openFilterPicker,
  openSortPicker,
  openPageSizePicker,
  refreshProviderFilterTree,
});

async function refreshProviderFilterTree() {
  const target = Array.isArray(providerTreeRef.value)
    ? providerTreeRef.value[0]
    : providerTreeRef.value;
  await target?.refresh?.();
}

const sortOptionLabelAsc = computed(() => {
  switch (sortField.value) {
    case "by-id": return t("gallery.byDefaultAsc");
    case "by-set-time": return t("gallery.bySetTimeAsc");
    case "by-name": return t("gallery.byNameAsc");
    case "by-size": return t("gallery.bySizeAsc");
    case "by-aspect": return t("gallery.byAspectWidthHeight");
    case "by-time": return t("gallery.byTimeAsc");
    case "by-album-order": return t("gallery.byAlbumDefaultSort");
  }
});
const sortOptionLabelDesc = computed(() => {
  switch (sortField.value) {
    case "by-id": return t("gallery.byDefaultDesc");
    case "by-set-time": return t("gallery.bySetTimeDesc");
    case "by-name": return t("gallery.byNameDesc");
    case "by-size": return t("gallery.bySizeDesc");
    case "by-aspect": return t("gallery.byAspectHeightWidth");
    case "by-time": return t("gallery.byTimeDesc");
    case "by-album-order": return t("gallery.byAlbumDefaultSort");
  }
});

function onSortOrderChange(value: string) {
  emit("update:sort", { ...props.sort, desc: value === "desc" });
}

// ========= Lazy loading =========
interface PluginGroupRow {
  plugin_id: string;
  count: number;
}

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

interface ProviderChildDir {
  name: string;
  meta: {
    isLeaf?: boolean;
    plain?: boolean;
  } | null;
  total: number | null;
}

interface PickerCascadeOption {
  text: string;
  value: string;
  children?: PickerCascadeOption[];
}

const pluginGroups = ref<PluginGroupRow[]>([]);
const mediaTypeCounts = ref<GalleryMediaTypeCountsPayload>({ imageCount: 0, videoCount: 0 });
const monthGroups = ref<DateGroupRow[]>([]);
const dayGroups = ref<DayGroupRow[]>([]);
const yearGroups = ref<YearGroupRow[]>([]);

const timeMenuRoots = computed<TimeMenuNode[]>(() =>
  buildGalleryTimeMenuTree(
    monthGroups.value,
    dayGroups.value,
    buildTimeMenuScopeLabels(t, String(locale.value)),
    yearGroups.value,
    { collapse: false },
  ),
);

async function countProviderPath(path: string): Promise<number> {
  const p = path.trim().replace(/\/+$/, "");
  if (!p) return 0;
  const res = await pathqlEntry(withGalleryPrefix(p));
  return typeof res?.total === "number" ? res.total : 0;
}

async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await pathqlList(withGalleryPrefix(path), true);
  return (Array.isArray(entries) ? entries : []).filter(
    (e): e is ProviderChildDir => !!e && typeof e.name === "string" && !!e.name,
  );
}

const YEAR_SEG_RE = /^(\d{4})y$/;
const MONTH_SEG_RE = /^(\d{2})m$/;
const DAY_SEG_RE = /^(\d{2})d$/;

type LazyScope =
  | "plugin"
  | "media-type"
  | "time-root"
  | `time-year:${string}`
  | `time-month:${string}`
  | `plugin-extend:${string}`;

const lazyLoadedKeys = ref(new Set<string>());
const lazyDirtyKeys = ref(new Set<string>());
const lazyPendingKeys = ref(new Set<string>());
const lazyVisibleLoadingKeys = ref(new Set<string>());
const lazyInFlight = new Map<string, Promise<void>>();
const lazyLoadingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pluginExtendChildren = ref<Record<string, ProviderChildDir[]>>({});

function currentLazyKey(scope: LazyScope, prefix = props.providerContextPrefix) {
  return `${prefix}|${scope}`;
}

function replaceSetValue(target: typeof lazyLoadedKeys, op: (next: Set<string>) => void) {
  const next = new Set(target.value);
  op(next);
  target.value = next;
}

function isLazyLoaded(scope: LazyScope) {
  return lazyLoadedKeys.value.has(currentLazyKey(scope));
}

function isLazyLoadingVisible(scope: LazyScope) {
  return lazyVisibleLoadingKeys.value.has(currentLazyKey(scope));
}

function startLazyLoadingUi(key: string) {
  replaceSetValue(lazyPendingKeys, (next) => next.add(key));
  replaceSetValue(lazyVisibleLoadingKeys, (next) => next.delete(key));
  if (lazyLoadingTimers.has(key)) {
    clearTimeout(lazyLoadingTimers.get(key)!);
  }
  lazyLoadingTimers.set(
    key,
    setTimeout(() => {
      if (lazyPendingKeys.value.has(key)) {
        replaceSetValue(lazyVisibleLoadingKeys, (next) => next.add(key));
      }
      lazyLoadingTimers.delete(key);
    }, 300),
  );
}

function finishLazyLoadingUi(key: string) {
  if (lazyLoadingTimers.has(key)) {
    clearTimeout(lazyLoadingTimers.get(key)!);
    lazyLoadingTimers.delete(key);
  }
  replaceSetValue(lazyPendingKeys, (next) => next.delete(key));
  replaceSetValue(lazyVisibleLoadingKeys, (next) => next.delete(key));
}

async function ensureLazyLoaded(scope: LazyScope, loader: (prefix: string) => Promise<void>) {
  const prefix = props.providerContextPrefix;
  const key = currentLazyKey(scope, prefix);
  if (lazyLoadedKeys.value.has(key) && !lazyDirtyKeys.value.has(key)) return;
  const existing = lazyInFlight.get(key);
  if (existing) return existing;

  startLazyLoadingUi(key);
  const task = (async () => {
    try {
      await loader(prefix);
      if (prefix === props.providerContextPrefix) {
        replaceSetValue(lazyLoadedKeys, (next) => next.add(key));
        replaceSetValue(lazyDirtyKeys, (next) => next.delete(key));
      }
    } finally {
      finishLazyLoadingUi(key);
      lazyInFlight.delete(key);
    }
  })();
  lazyInFlight.set(key, task);
  return task;
}

function resetLazyDataForPrefixChange() {
  for (const timer of lazyLoadingTimers.values()) {
    clearTimeout(timer);
  }
  lazyLoadingTimers.clear();
  lazyInFlight.clear();
  lazyLoadedKeys.value = new Set();
  lazyDirtyKeys.value = new Set();
  lazyPendingKeys.value = new Set();
  lazyVisibleLoadingKeys.value = new Set();
  pluginGroups.value = [];
  pluginExtendChildren.value = {};
  mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
  yearGroups.value = [];
  monthGroups.value = [];
  dayGroups.value = [];
}

watch(() => props.providerContextPrefix, () => {
  resetLazyDataForPrefixChange();
});

onUnmounted(() => {
  for (const timer of lazyLoadingTimers.values()) {
    clearTimeout(timer);
  }
  lazyLoadingTimers.clear();
});

function parsePluginExtendScope(scope: string) {
  const raw = scope.slice("plugin-extend:".length);
  const tab = raw.indexOf("\t");
  if (tab < 0) return { pluginId: raw, extendPath: "" };
  return { pluginId: raw.slice(0, tab), extendPath: raw.slice(tab + 1) };
}

async function ensurePluginGroupsLoaded() {
  await ensureLazyLoaded("plugin", async (prefix) => {
    try {
      const entries = await listProviderDirs(`${prefix}plugin/`);
      const groups = await Promise.all(
        entries.map(async (e) => ({
          plugin_id: e.name,
          count: typeof e.total === "number"
            ? e.total
            : await countProviderPath(`${prefix}plugin/${encodeURIComponent(e.name)}`),
        })),
      );
      if (prefix !== props.providerContextPrefix) return;
      pluginGroups.value = groups.filter((r) => r.count > 0);
    } catch {
      if (prefix === props.providerContextPrefix) pluginGroups.value = [];
    }
  });
}

function normalizeExtendPath(path = "") {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function pluginExtendKey(pluginId: string, extendPath = "") {
  const path = normalizeExtendPath(extendPath);
  return path ? `${pluginId}\t${path}` : pluginId;
}

function parsePluginExtendKey(key: string) {
  const tab = key.indexOf("\t");
  if (tab < 0) return { pluginId: key, extendPath: "" };
  return { pluginId: key.slice(0, tab), extendPath: key.slice(tab + 1) };
}

function pluginExtendScope(pluginId: string, extendPath = ""): LazyScope {
  return `plugin-extend:${pluginExtendKey(pluginId, extendPath)}`;
}

function pluginExtendPathForProvider(extendPath = "") {
  return normalizeExtendPath(extendPath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function isProviderLeaf(entry: ProviderChildDir) {
  return entry.meta?.isLeaf === true;
}

function pluginCommand(pluginId: string, extendPath = "") {
  return extendPath ? `${pluginId}\t${extendPath}` : pluginId;
}

function parsePluginCommand(command: string) {
  const [pluginId, extendPath = ""] = String(command || "").split("\t");
  return { pluginId: pluginId.trim(), extendPath: extendPath.trim() };
}

async function ensurePluginExtendLoaded(pluginId: string, extendPath = "") {
  const id = pluginId.trim();
  if (!id) return;
  const path = normalizeExtendPath(extendPath);
  await ensureLazyLoaded(pluginExtendScope(id, path), async (prefix) => {
    try {
      const providerPath = pluginExtendPathForProvider(path);
      const entries = await listProviderDirs(
        `${prefix}plugin/${encodeURIComponent(id)}/extend/${providerPath}`,
      );
      if (prefix !== props.providerContextPrefix) return;
      pluginExtendChildren.value = {
        ...pluginExtendChildren.value,
        [pluginExtendKey(id, path)]: entries,
      };
    } catch {
      if (prefix === props.providerContextPrefix) {
        pluginExtendChildren.value = {
          ...pluginExtendChildren.value,
          [pluginExtendKey(id, path)]: [],
        };
      }
    }
  });
}

async function ensureAllPluginExtendsLoaded() {
  await Promise.all(pluginGroups.value.map((g) => ensurePluginExtendTreeLoaded(g.plugin_id)));
}

async function ensurePluginExtendTreeLoaded(pluginId: string, extendPath = "", depth = 0) {
  if (depth > 3) return;
  await ensurePluginExtendLoaded(pluginId, extendPath);
  const children = pluginExtendChildren.value[pluginExtendKey(pluginId, extendPath)] ?? [];
  await Promise.all(
    children
      .filter((child) => !isProviderLeaf(child))
      .map((child) =>
        ensurePluginExtendTreeLoaded(
          pluginId,
          [normalizeExtendPath(extendPath), child.name].filter(Boolean).join("/"),
          depth + 1,
        ),
      ),
  );
}

async function ensureMediaTypeCountsLoaded() {
  await ensureLazyLoaded("media-type", async (prefix) => {
    try {
      const [imageCount, videoCount] = await Promise.all([
        countProviderPath(`${prefix}media-type/image`),
        countProviderPath(`${prefix}media-type/video`),
      ]);
      if (prefix !== props.providerContextPrefix) return;
      mediaTypeCounts.value = { imageCount, videoCount };
    } catch {
      if (prefix === props.providerContextPrefix) {
        mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
      }
    }
  });
}

async function ensureTimeRootLoaded() {
  await ensureLazyLoaded("time-root", async (prefix) => {
    try {
      const yearEntries = await listProviderDirs(`${prefix}date/`);
      const yearCandidates = yearEntries
        .map((e) => {
          const m = YEAR_SEG_RE.exec(e.name);
          return m ? { year: m[1]!, seg: e.name } : null;
        })
        .filter((y): y is { year: string; seg: string } => !!y);
      const years = (
        await Promise.all(
          yearCandidates.map(async (y) => ({
            year: y.year,
            count: await countProviderPath(`${prefix}date/${y.seg}`),
          })),
        )
      ).filter((y) => y.count > 0);
      if (prefix !== props.providerContextPrefix) return;
      yearGroups.value = years;
    } catch {
      if (prefix === props.providerContextPrefix) {
        yearGroups.value = [];
        monthGroups.value = [];
        dayGroups.value = [];
      }
    }
  });
}

async function ensureTimeYearMonthsLoaded(year: string) {
  if (!/^\d{4}$/.test(year)) return;
  await ensureLazyLoaded(`time-year:${year}`, async (prefix) => {
    try {
      const yearSeg = `${year}y`;
      const monthEntries = await listProviderDirs(`${prefix}date/${yearSeg}/`);
      const monthCandidates = monthEntries
        .map((e) => {
          const m = MONTH_SEG_RE.exec(e.name);
          return m ? { month: m[1]!, seg: e.name } : null;
        })
        .filter((m): m is { month: string; seg: string } => !!m);
      const months = (
        await Promise.all(
          monthCandidates.map(async (mo) => ({
            year_month: `${year}-${mo.month}`,
            count: await countProviderPath(`${prefix}date/${yearSeg}/${mo.seg}`),
          })),
        )
      ).filter((mo) => mo.count > 0);
      if (prefix !== props.providerContextPrefix) return;
      monthGroups.value = [
        ...monthGroups.value.filter((m) => !m.year_month.startsWith(`${year}-`)),
        ...months,
      ];
      dayGroups.value = dayGroups.value.filter((d) => !d.ymd.startsWith(`${year}-`));
    } catch {
      if (prefix === props.providerContextPrefix) {
        monthGroups.value = monthGroups.value.filter((m) => !m.year_month.startsWith(`${year}-`));
        dayGroups.value = dayGroups.value.filter((d) => !d.ymd.startsWith(`${year}-`));
      }
    }
  });
}

async function ensureTimeMonthDaysLoaded(yearMonth: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return;
  const [, year, month] = m;
  await ensureLazyLoaded(`time-month:${yearMonth}`, async (prefix) => {
    try {
      const yearSeg = `${year}y`;
      const monthSeg = `${month}m`;
      const dayEntries = await listProviderDirs(`${prefix}date/${yearSeg}/${monthSeg}/`);
      const dayCandidates = dayEntries
        .map((e) => {
          const dm = DAY_SEG_RE.exec(e.name);
          return dm ? { day: dm[1]!, seg: e.name } : null;
        })
        .filter((d): d is { day: string; seg: string } => !!d);
      const days = (
        await Promise.all(
          dayCandidates.map(async (d) => ({
            ymd: `${yearMonth}-${d.day}`,
            count: await countProviderPath(`${prefix}date/${yearSeg}/${monthSeg}/${d.seg}`),
          })),
        )
      ).filter((d) => d.count > 0);
      if (prefix !== props.providerContextPrefix) return;
      dayGroups.value = [
        ...dayGroups.value.filter((d) => !d.ymd.startsWith(`${yearMonth}-`)),
        ...days,
      ];
    } catch {
      if (prefix === props.providerContextPrefix) {
        dayGroups.value = dayGroups.value.filter((d) => !d.ymd.startsWith(`${yearMonth}-`));
      }
    }
  });
}

async function ensureTimeNodeChildrenLoaded(node: TimeMenuNode) {
  if (/^\d{4}$/.test(node.name)) {
    await ensureTimeYearMonthsLoaded(node.name);
  } else if (/^\d{4}-\d{2}$/.test(node.name)) {
    await ensureTimeMonthDaysLoaded(node.name);
  }
}

// ========= Android pickers =========
const filterPicker = useModal();
const timeFilterPicker = useModal();
const pluginFilterPicker = useModal();
const mediaTypeFilterPicker = useModal();
const nameFilterPicker = useModal();
const aspectFilterPicker = useModal();
const sortPicker = useModal();
const pageSizePicker = useModal();

const isWallpaperOrderBrowse = computed(() => !!activeFilters.value.wallpaperOrder);
const isTimeFilterBrowse = computed(() => filterDateSegment(activeFilters.value) !== null);
const isPluginFilterBrowse = computed(() => filterPluginId(activeFilters.value) !== null);
const isMediaTypeFilterBrowse = computed(() => filterMediaKind(activeFilters.value) !== null);
const isNameBrowse = computed(() => filterNameBucket(activeFilters.value) !== null);
const isAspectBrowse = computed(() => filterAspectRange(activeFilters.value) !== null);

const filterPickerColumns = computed(() => [
  { text: t("gallery.filterAll"), value: "all" },
  { text: t("gallery.filterByTime"), value: "time" },
  { text: t("gallery.filterByPlugin"), value: "plugin" },
  { text: t("gallery.filterByMediaType"), value: "media-type" },
  { text: t("gallery.filterByAspect"), value: "aspect" },
  { text: t("gallery.filterByName"), value: "name" },
  { text: t("gallery.filterWallpaperSet"), value: "wallpaper-order" },
]);

const filterPickerSelected = ref<string[]>(["all"]);
watch(filterPicker.isOpen, (open) => {
  if (open) {
    if (isWallpaperOrderBrowse.value) filterPickerSelected.value = ["wallpaper-order"];
    else if (isTimeFilterBrowse.value) filterPickerSelected.value = ["time"];
    else if (isPluginFilterBrowse.value) filterPickerSelected.value = ["plugin"];
    else if (isMediaTypeFilterBrowse.value) filterPickerSelected.value = ["media-type"];
    else if (isNameBrowse.value) filterPickerSelected.value = ["name"];
    else if (isAspectBrowse.value) filterPickerSelected.value = ["aspect"];
    else filterPickerSelected.value = ["all"];
  }
});

const currentPluginId = computed(() => filterPluginId(activeFilters.value));
const dateTail = computed(() => filterDateSegment(activeFilters.value));

async function onFilterPickerConfirm() {
  filterPicker.close();
  const v = filterPickerSelected.value[0];
  if (v === "time") {
    await ensureTimeRootLoaded();
    await ensureTimeTailLoaded(dateTail.value);
    if (!timeMenuRoots.value.length) return;
    timeFilterPicker.open();
    return;
  }
  if (v === "plugin") {
    await ensurePluginGroupsLoaded();
    await ensureAllPluginExtendsLoaded();
    if (!pluginGroups.value.length) return;
    pluginFilterPicker.open();
    return;
  }
  if (v === "media-type") {
    await ensureMediaTypeCountsLoaded();
    mediaTypeFilterPicker.open();
    return;
  }
  if (v === "name") {
    nameFilterPicker.open();
    return;
  }
  if (v === "aspect") {
    aspectFilterPicker.open();
    return;
  }
  if (v === "all" || v === "wallpaper-order") {
    emit(
      "update:filters",
      v === "all" ? {} : { wallpaperOrder: true },
    );
  }
}

const timeFilterPickerTitle = computed(() => t("gallery.filterByTime"));
const timeFilterPickerColumns = ref<{ text: string; value: string }[][]>([]);
const timeFilterPickerSelected = ref<string[]>([]);

function applyTimeMenuPickerState(raw: readonly string[]) {
  const roots = timeMenuRoots.value;
  const { columns, values } = syncTimeMenuPickerState(roots, raw);
  timeFilterPickerColumns.value = columns;
  timeFilterPickerSelected.value = values;
}

function findTimeNodeByPickerValues(raw: readonly string[]) {
  let nodes = timeMenuRoots.value;
  let found: TimeMenuNode | null = null;
  for (const value of raw) {
    const node = nodes.find((n) => (n.key ?? n.name) === value);
    if (!node) break;
    found = node;
    nodes = node.children ?? [];
  }
  return found;
}

async function ensureTimeTailLoaded(tail: string | null) {
  const s = tail?.trim();
  if (!s) return;
  const year = /^(\d{4})(?:-\d{2})?(?:-\d{2})?$/.exec(s)?.[1];
  if (year) await ensureTimeYearMonthsLoaded(year);
  const yearMonth = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(s)?.[1];
  if (yearMonth) await ensureTimeMonthDaysLoaded(yearMonth);
}

watch(timeFilterPicker.isOpen, (open) => {
  if (!open) return;
  const roots = timeMenuRoots.value;
  const initial = resolveInitialTimePickPath(roots, dateTail.value);
  applyTimeMenuPickerState(initial);
});

async function onTimeFilterPickerChange(payload: {
  selectedValues: (string | number)[];
  columnIndex: number;
}) {
  const { columnIndex, selectedValues } = payload;
  const maxD = getTimeMenuMaxDepth(timeMenuRoots.value);
  if (columnIndex >= maxD - 1) return;
  const values = selectedValues.map(String);
  const node = findTimeNodeByPickerValues(values);
  if (node) await ensureTimeNodeChildrenLoaded(node);
  applyTimeMenuPickerState(values);
}

function onTimeFilterPickerConfirm(payload: {
  selectedValues: (string | number)[];
}) {
  timeFilterPicker.close();
  const roots = timeMenuRoots.value;
  const tail = resolveTimeMenuPickToDateTail(
    roots,
    payload.selectedValues.map(String),
  );
  if (!tail) return;
  emit("update:filters", singleFilterToSet({ type: "date", segment: tail }));
}

const pluginFilterPickerColumns = computed(() => {
  void locale.value;
  const rows: PickerCascadeOption[] = [];
  for (const g of pluginGroups.value) {
    const pluginLabel = pluginStore.pluginLabel(g.plugin_id);
    const children: PickerCascadeOption[] = [
      {
        text: `${t("gallery.filterAll")} (${g.count})`,
        value: pluginCommand(g.plugin_id),
      },
    ];
    children.push(...pluginExtendPickerOptions(g.plugin_id));
    rows.push({
      text: `${pluginLabel} (${g.count})`,
      value: g.plugin_id,
      children,
    });
  }
  return rows;
});

function pluginExtendPickerOptions(pluginId: string, parentPath = ""): PickerCascadeOption[] {
  return (pluginExtendChildren.value[pluginExtendKey(pluginId, parentPath)] ?? []).map((child) => {
    const path = [normalizeExtendPath(parentPath), child.name].filter(Boolean).join("/");
    const nested = isProviderLeaf(child) ? [] : pluginExtendPickerOptions(pluginId, path);
    return {
      text: child.name,
      value: pluginCommand(pluginId, path),
      children: nested.length ? nested : undefined,
    };
  });
}

function isPluginCommandPlain(command: string) {
  const { pluginId, extendPath } = parsePluginCommand(command);
  if (!pluginId || !extendPath) return false;
  const child = pluginExtendChildren.value[pluginExtendKey(pluginId, extendPath)]?.[0];
  return child ? child.meta?.plain === true : false;
}

const pluginFilterPickerSelected = ref<string[]>([]);
watch(pluginFilterPicker.isOpen, (open) => {
  if (open) {
    const id = currentPluginId.value || pluginGroups.value[0]?.plugin_id || "";
    const extendPath = activeFilters.value.plugin?.extendPath ?? "";
    pluginFilterPickerSelected.value = id ? [id, pluginCommand(id, extendPath)] : [];
  }
});

function onPluginFilterPickerConfirm() {
  const selected = pluginFilterPickerSelected.value;
  const command = selected[selected.length - 1] ?? "";
  if (isPluginCommandPlain(command)) return;
  pluginFilterPicker.close();
  const { pluginId: id, extendPath } = parsePluginCommand(command);
  if (!id) return;
  emit(
    "update:filters",
    singleFilterToSet(
      extendPath ? { type: "plugin", pluginId: id, extendPath } : { type: "plugin", pluginId: id },
    ),
  );
}

const mediaTypeFilterPickerColumns = computed(() => {
  void locale.value;
  const { imageCount, videoCount } = mediaTypeCounts.value;
  return [
    { text: `${t("gallery.filterImageOnly")} (${imageCount})`, value: "image" },
    { text: `${t("gallery.filterVideoOnly")} (${videoCount})`, value: "video" },
  ];
});

const mediaTypeFilterPickerSelected = ref<string[]>(["image"]);
watch(mediaTypeFilterPicker.isOpen, (open) => {
  if (open) {
    const k = filterMediaKind(activeFilters.value);
    mediaTypeFilterPickerSelected.value = [k === "video" ? "video" : "image"];
  }
});

function onMediaTypeFilterPickerConfirm() {
  mediaTypeFilterPicker.close();
  const kind = mediaTypeFilterPickerSelected.value[0];
  if (kind !== "image" && kind !== "video") return;
  emit("update:filters", singleFilterToSet({ type: "media-type", kind }));
}

const nameFilterPickerColumns = computed(() =>
  GALLERY_NAME_LANGUAGE_BUCKETS.map((b) => ({
    text: b.autonym,
    value: b.bucket,
  })),
);

const nameFilterPickerSelected = ref<string[]>(["english"]);
watch(nameFilterPicker.isOpen, (open) => {
  if (open) {
    nameFilterPickerSelected.value = [
      filterNameBucket(activeFilters.value) ?? GALLERY_NAME_LANGUAGE_BUCKETS[0].bucket,
    ];
  }
});

function onNameFilterPickerConfirm() {
  nameFilterPicker.close();
  const bucket = nameFilterPickerSelected.value[0]?.trim();
  if (!bucket) return;
  emit("update:filters", singleFilterToSet({ type: "name", bucket }));
}

const aspectFilterPickerColumns = computed(() =>
  GALLERY_ASPECT_BUCKETS.map((b) => ({
    text: t(`gallery.${b.labelKey}`),
    value: b.range,
  })),
);

const aspectFilterPickerSelected = ref<string[]>([GALLERY_ASPECT_BUCKETS[0].range]);
watch(aspectFilterPicker.isOpen, (open) => {
  if (open) {
    aspectFilterPickerSelected.value = [
      filterAspectRange(activeFilters.value) ?? GALLERY_ASPECT_BUCKETS[0].range,
    ];
  }
});

function onAspectFilterPickerConfirm() {
  aspectFilterPicker.close();
  const range = aspectFilterPickerSelected.value[0]?.trim();
  if (!range) return;
  emit("update:filters", singleFilterToSet({ type: "aspect", range }));
}

const sortPickerColumns = computed(() => [
  { text: sortOptionLabelAsc.value, value: "asc" },
  { text: sortOptionLabelDesc.value, value: "desc" },
]);

const sortPickerSelected = ref<string[]>(["asc"]);
watch(sortPicker.isOpen, (open) => {
  if (open) sortPickerSelected.value = [sortOrder.value];
});

function onSortPickerConfirm() {
  sortPicker.close();
  const v = sortPickerSelected.value[0];
  if (v === "asc" || v === "desc") onSortOrderChange(v);
}

const pageSizePickerColumns = computed(() =>
  pageSizeOptions.map((n) => ({ text: String(n), value: String(n) })),
);

const pageSizePickerSelected = ref<string[]>(["100"]);
watch(pageSizePicker.isOpen, (open) => {
  if (open) pageSizePickerSelected.value = [String(props.pageSize)];
});

function onPageSizePickerConfirm() {
  pageSizePicker.close();
  const v = pageSizePickerSelected.value[0];
  const n = Number(v);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  emit("update:pageSize", n);
}

function openFilterPicker() {
  filterPicker.open();
}
function openSortPicker() {
  sortPicker.open();
}
function openPageSizePicker() {
  pageSizePicker.open();
}
</script>
