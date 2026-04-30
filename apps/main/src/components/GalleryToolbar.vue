<template>
  <PageHeader :title="$t('gallery.gallery')" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span>{{ totalCountText }}</span>
    </template>
  </PageHeader>

  <!-- 桌面：过滤（全部 / 壁纸 / 按时间嵌套 / 按插件）+ 排序（任意根路径），置于标题与分页器之间 -->
  <div v-if="!uiStore.isCompact" class="gallery-browse-toolbar">
    <el-dropdown v-if="showGalleryFilterFold" trigger="click" @command="onDesktopFilterCommand">
      <el-button class="gallery-browse-btn">
        <el-icon class="gallery-browse-icon">
          <Filter />
        </el-icon>
        <span>{{ filterFoldLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="all" :class="{ 'is-active': isAllFilterBrowse }">
            {{ t("gallery.filterAll") }}
          </el-dropdown-item>
          <el-dropdown-item
            command="wallpaper-order"
            :class="{ 'is-active': isWallpaperOrderBrowse }"
          >
            {{ t("gallery.filterWallpaperSet") }}
          </el-dropdown-item>
          <el-dropdown-item divided class="plugin-submenu-wrap" @click.stop>
            <el-dropdown
              trigger="hover"
              placement="right-start"
              @command="onDesktopTimeFilterCommand"
              @visible-change="onDesktopTimeMenuVisible"
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isTimeFilterBrowse }"
                @mouseenter="void ensureTimeRootLoaded()"
              >
                {{ t("gallery.filterByTime") }}
                <el-icon class="plugin-submenu-chevron">
                  <ArrowRight />
                </el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu class="plugin-submenu-menu">
                  <template v-if="timeMenuRoots.length">
                    <GalleryTimeFilterSubmenu
                      :nodes="timeMenuRoots"
                      :date-tail="dateTail"
                      :loading-names="visibleTimeLoadingNames"
                      :loading-text="t('common.loading')"
                      @command="onDesktopTimeFilterCommand"
                      @lazy-open="(node) => void ensureTimeNodeChildrenLoaded(node)"
                    />
                  </template>
                  <el-dropdown-item v-else-if="isLazyLoadingVisible('time-root')" disabled>
                    {{ t("common.loading") }}
                  </el-dropdown-item>
                  <el-dropdown-item v-else-if="isLazyLoaded('time-root')" disabled>
                    {{ t("gallery.filterByTimeEmpty") }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-dropdown-item>
          <el-dropdown-item class="plugin-submenu-wrap" @click.stop>
            <el-dropdown
              trigger="hover"
              placement="right-start"
              @command="onDesktopPluginFilterCommand"
              @visible-change="onDesktopPluginMenuVisible"
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isPluginFilterBrowse }"
                @mouseenter="void ensurePluginGroupsLoaded()"
              >
                {{ t("gallery.filterByPlugin") }}
                <el-icon class="plugin-submenu-chevron">
                  <ArrowRight />
                </el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu class="plugin-submenu-menu">
                  <el-dropdown-item v-if="isLazyLoadingVisible('plugin')" disabled>
                    {{ t("common.loading") }}
                  </el-dropdown-item>
                  <template v-else-if="pluginGroups.length">
                    <el-dropdown-item
                      v-for="g in pluginGroups"
                      :key="g.plugin_id"
                      :command="g.plugin_id"
                      :class="{ 'is-active': currentPluginId === g.plugin_id }"
                    >
                      {{ pluginStore.pluginLabel(g.plugin_id) }}
                      <span class="plugin-count">({{ g.count }})</span>
                    </el-dropdown-item>
                  </template>
                  <el-dropdown-item v-else-if="isLazyLoaded('plugin')" disabled>
                    {{ t("gallery.filterByPluginEmpty") }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-dropdown-item>
          <el-dropdown-item divided class="plugin-submenu-wrap" @click.stop>
            <el-dropdown
              trigger="hover"
              placement="right-start"
              @command="onDesktopMediaTypeFilterCommand"
              @visible-change="onDesktopMediaTypeMenuVisible"
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isMediaTypeFilterBrowse }"
                @mouseenter="void ensureMediaTypeCountsLoaded()"
              >
                {{ t("gallery.filterByMediaType") }}
                <el-icon class="plugin-submenu-chevron">
                  <ArrowRight />
                </el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu class="plugin-submenu-menu">
                  <el-dropdown-item v-if="isLazyLoadingVisible('media-type')" disabled>
                    {{ t("common.loading") }}
                  </el-dropdown-item>
                  <el-dropdown-item
                    v-else
                    command="image"
                    :class="{
                      'is-active': filterMediaKind(props.filter) === 'image',
                    }"
                  >
                    {{ t("gallery.filterImageOnly") }}
                    <span class="plugin-count">({{ mediaTypeCounts.imageCount }})</span>
                  </el-dropdown-item>
                  <el-dropdown-item
                    v-if="!isLazyLoadingVisible('media-type')"
                    command="video"
                    :class="{
                      'is-active': filterMediaKind(props.filter) === 'video',
                    }"
                  >
                    {{ t("gallery.filterVideoOnly") }}
                    <span class="plugin-count">({{ mediaTypeCounts.videoCount }})</span>
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dropdown trigger="click" @command="onDesktopSortCommand">
      <el-button class="gallery-browse-btn">
        <el-icon class="gallery-browse-icon">
          <Sort />
        </el-icon>
        <span>{{ sortToolbarButtonLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="asc" :class="{ 'is-active': sortOrder === 'asc' }">
            {{ sortOptionLabelAsc }}
          </el-dropdown-item>
          <el-dropdown-item command="desc" :class="{ 'is-active': sortOrder === 'desc' }">
            {{ sortOptionLabelDesc }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-dropdown trigger="click" @command="onDesktopPageSizeCommand">
      <el-button class="gallery-browse-btn">
        <el-icon class="gallery-browse-icon">
          <Histogram />
        </el-icon>
        <span>{{ pageSizeLabel }}</span>
        <el-icon class="el-icon--right">
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

    <SearchInput
      :model-value="search"
      :placeholder="t('gallery.searchPlaceholder')"
      class="gallery-browse-search"
      @update:model-value="(v) => emit('update:search', v)"
    />
  </div>

  <!-- Android：fold 中「过滤」「排序」弹出的 van-picker -->
  <Teleport v-if="uiStore.isCompact" to="body">
    <van-popup v-model:show="showFilterPicker" position="bottom" round>
      <van-picker
        v-model="filterPickerSelected"
        :title="$t('gallery.filter')"
        :columns="filterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onFilterPickerConfirm"
        @cancel="showFilterPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showTimeFilterPicker" position="bottom" round>
      <van-picker
        v-model="timeFilterPickerSelected"
        :title="timeFilterPickerTitle"
        :columns="timeFilterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onTimeFilterPickerConfirm"
        @change="onTimeFilterPickerChange"
        @cancel="showTimeFilterPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showPluginFilterPicker" position="bottom" round>
      <van-picker
        v-model="pluginFilterPickerSelected"
        :title="t('gallery.filterByPlugin')"
        :columns="pluginFilterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onPluginFilterPickerConfirm"
        @cancel="showPluginFilterPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showMediaTypeFilterPicker" position="bottom" round>
      <van-picker
        v-model="mediaTypeFilterPickerSelected"
        :title="t('gallery.filterByMediaType')"
        :columns="mediaTypeFilterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onMediaTypeFilterPickerConfirm"
        @cancel="showMediaTypeFilterPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showSortPicker" position="bottom" round>
      <van-picker
        v-model="sortPickerSelected"
        :title="$t('gallery.byTime')"
        :columns="sortPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onSortPickerConfirm"
        @cancel="showSortPicker = false"
      />
    </van-popup>
    <van-popup v-model:show="showPageSizePicker" position="bottom" round>
      <van-picker
        v-model="pageSizePickerSelected"
        :title="$t('gallery.pageSize')"
        :columns="pageSizePickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onPageSizePickerConfirm"
        @cancel="showPageSizePicker = false"
      />
    </van-popup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { ArrowDown, ArrowRight, Filter, Histogram, Sort } from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import SearchInput from "@/components/SearchInput.vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import {
  filterDateSegment,
  filterMediaKind,
  filterPluginId,
  isSimpleFilter,
  type GalleryFilter,
  type GalleryTimeSort,
} from "@/utils/galleryPath";
import {
  buildGalleryTimeMenuTree,
  buildTimeMenuScopeLabels,
  getTimeMenuMaxDepth,
  resolveInitialTimePickPath,
  resolveTimeMenuPickToDateTail,
  syncTimeMenuPickerState,
  type DateGroupRow,
  type DayGroupRow,
  type TimeMenuNode,
  type YearGroupRow,
} from "@/utils/galleryTimeFilterMenu";
import GalleryTimeFilterSubmenu from "@/header/comps/GalleryTimeFilterSubmenu.vue";
import { usePluginStore } from "@/stores/plugins";
import { useFailedImagesStore } from "@/stores/failedImages";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { storeToRefs } from "pinia";
import { useUiStore } from "@kabegame/core/stores/ui";

interface Props {
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  monthOptions?: string[];
  monthLoading?: boolean;
  selectedRange?: [string, string] | null; // YYYY-MM-DD
  filter?: GalleryFilter;
  sort?: GalleryTimeSort;
  /** 每页条数（与设置同步，用于工具栏展示） */
  pageSize?: number;
  /** display_name 搜索词 */
  search?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  monthOptions: () => [],
  monthLoading: false,
  selectedRange: null,
  filter: () => ({ type: "all" } as GalleryFilter),
  sort: "asc",
  pageSize: 100,
  search: "",
});

const router = useRouter();
const failedImagesStore = useFailedImagesStore();
const galleryRouteStore = useGalleryRouteStore();
const { hide: galleryHide } = storeToRefs(galleryRouteStore);
const failedCountFoldLabel = computed(() => {
  const n = failedImagesStore.allFailed.length;
  const suffix = n >= 99 ? "99+" : String(n);
  return `${t("header.failedImages")} (${suffix})`;
});
const sortOrder = computed<GalleryTimeSort>(() =>
  props.sort === "desc" ? "desc" : "asc"
);
const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const isWallpaperOrderBrowse = computed(
  () => props.filter.type === "wallpaper-order"
);

const uiStore = useUiStore();

const currentPluginId = computed(() => filterPluginId(props.filter));

const dateTail = computed(() => filterDateSegment(props.filter));

const isPluginFilterBrowse = computed(() => currentPluginId.value != null);

const isTimeFilterBrowse = computed(() => dateTail.value != null);

const isMediaTypeFilterBrowse = computed(
  () => filterMediaKind(props.filter) != null
);

const isAllFilterBrowse = computed(() => props.filter.type === "all");

const showGalleryFilterFold = computed(() => isSimpleFilter(props.filter));

interface PluginGroupRow {
  plugin_id: string;
  count: number;
}

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

/** list_provider_children 返回的子条目形状 */
interface ProviderChildDir {
  kind: "dir";
  name: string;
  total?: number | null;
}

interface ProviderCountResult {
  total?: number | null;
}

const pluginGroups = ref<PluginGroupRow[]>([]);
const mediaTypeCounts = ref<GalleryMediaTypeCountsPayload>({
  imageCount: 0,
  videoCount: 0,
});
const monthGroups = ref<DateGroupRow[]>([]);
const dayGroups = ref<DayGroupRow[]>([]);
const yearGroups = ref<YearGroupRow[]>([]);

const timeMenuRoots = computed<TimeMenuNode[]>(() =>
  buildGalleryTimeMenuTree(
    monthGroups.value,
    dayGroups.value,
    buildTimeMenuScopeLabels(t, String(locale.value)),
    yearGroups.value,
    { collapse: false }
  )
);

/** 当前上下文前缀：hide + search，由 galleryRouteStore 统一拼出。
 *  各 filter 列表查询（`plugin/` / `media-type/` / `date/`）都拼这个前缀，
 *  保证 hide 状态与搜索词对预览计数生效。 */
const { contextPath: filterContextPrefix } = storeToRefs(galleryRouteStore);

async function countProviderPath(path: string): Promise<number> {
  const p = path.trim().replace(/\/+$/, "");
  if (!p) return 0;
  const res = await invoke<ProviderCountResult>("browse_gallery_provider", {
    path: p,
  });
  return typeof res?.total === "number" ? res.total : 0;
}

async function listProviderDirs(path: string): Promise<ProviderChildDir[]> {
  const entries = await invoke<ProviderChildDir[]>("list_provider_children", {
    path,
  });
  return (Array.isArray(entries) ? entries : []).filter(
    (e): e is ProviderChildDir => !!e && e.kind === "dir" && typeof e.name === "string" && !!e.name
  );
}

const YEAR_SEG_RE = /^(\d{4})y$/;
const MONTH_SEG_RE = /^(\d{2})m$/;
const DAY_SEG_RE = /^(\d{2})d$/;

type LazyScope = "plugin" | "media-type" | "time-root" | `time-year:${string}` | `time-month:${string}`;

const lazyLoadedKeys = ref(new Set<string>());
const lazyDirtyKeys = ref(new Set<string>());
const lazyPendingKeys = ref(new Set<string>());
const lazyVisibleLoadingKeys = ref(new Set<string>());
const lazyInFlight = new Map<string, Promise<void>>();
const lazyLoadingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function currentLazyKey(scope: LazyScope, prefix = filterContextPrefix.value) {
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
    }, 300)
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
  const prefix = filterContextPrefix.value;
  const key = currentLazyKey(scope, prefix);
  if (lazyLoadedKeys.value.has(key) && !lazyDirtyKeys.value.has(key)) return;
  const existing = lazyInFlight.get(key);
  if (existing) return existing;

  startLazyLoadingUi(key);
  const task = (async () => {
    try {
      await loader(prefix);
      if (prefix === filterContextPrefix.value) {
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
  mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
  yearGroups.value = [];
  monthGroups.value = [];
  dayGroups.value = [];
}

function markFilterLazyDataDirty() {
  lazyDirtyKeys.value = new Set(lazyLoadedKeys.value);
}

watch(filterContextPrefix, () => {
  resetLazyDataForPrefixChange();
});

onUnmounted(() => {
  for (const timer of lazyLoadingTimers.values()) {
    clearTimeout(timer);
  }
  lazyLoadingTimers.clear();
});

useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 500,
  onRefresh: markFilterLazyDataDirty,
});

async function ensurePluginGroupsLoaded() {
  await ensureLazyLoaded("plugin", async (prefix) => {
    try {
      const entries = await listProviderDirs(`${prefix}plugin/`);
      const groups = await Promise.all(
        entries.map(async (e) => ({
          plugin_id: e.name,
          count: await countProviderPath(`${prefix}plugin/${encodeURIComponent(e.name)}`),
        }))
      );
      if (prefix !== filterContextPrefix.value) return;
      pluginGroups.value = groups.filter((r) => r.count > 0);
    } catch {
      if (prefix === filterContextPrefix.value) pluginGroups.value = [];
    }
  });
}

async function ensureMediaTypeCountsLoaded() {
  await ensureLazyLoaded("media-type", async (prefix) => {
    try {
      const [imageCount, videoCount] = await Promise.all([
        countProviderPath(`${prefix}media-type/image`),
        countProviderPath(`${prefix}media-type/video`),
      ]);
      if (prefix !== filterContextPrefix.value) return;
      mediaTypeCounts.value = { imageCount, videoCount };
    } catch {
      if (prefix === filterContextPrefix.value) {
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
          }))
        )
      ).filter((y) => y.count > 0);
      if (prefix !== filterContextPrefix.value) return;
      yearGroups.value = years;
    } catch {
      if (prefix === filterContextPrefix.value) {
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
          }))
        )
      ).filter((mo) => mo.count > 0);
      if (prefix !== filterContextPrefix.value) return;
      monthGroups.value = [
        ...monthGroups.value.filter((m) => !m.year_month.startsWith(`${year}-`)),
        ...months,
      ];
      dayGroups.value = dayGroups.value.filter((d) => !d.ymd.startsWith(`${year}-`));
    } catch {
      if (prefix === filterContextPrefix.value) {
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
          }))
        )
      ).filter((d) => d.count > 0);
      if (prefix !== filterContextPrefix.value) return;
      dayGroups.value = [
        ...dayGroups.value.filter((d) => !d.ymd.startsWith(`${yearMonth}-`)),
        ...days,
      ];
    } catch {
      if (prefix === filterContextPrefix.value) {
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

function onDesktopTimeMenuVisible(open: boolean) {
  if (open) void ensureTimeRootLoaded();
}

function onDesktopPluginMenuVisible(open: boolean) {
  if (open) void ensurePluginGroupsLoaded();
}

function onDesktopMediaTypeMenuVisible(open: boolean) {
  if (open) void ensureMediaTypeCountsLoaded();
}

const visibleTimeLoadingNames = computed(() => {
  const names = new Set<string>();
  for (const key of lazyVisibleLoadingKeys.value) {
    const scope = key.slice(key.indexOf("|") + 1);
    if (scope.startsWith("time-year:")) {
      names.add(scope.slice("time-year:".length));
    } else if (scope.startsWith("time-month:")) {
      names.add(scope.slice("time-month:".length));
    }
  }
  return names;
});

const sortOptionLabelAsc = computed(() =>
  isWallpaperOrderBrowse.value
    ? t("gallery.bySetTimeAsc")
    : t("gallery.byTimeAsc")
);
const sortOptionLabelDesc = computed(() =>
  isWallpaperOrderBrowse.value
    ? t("gallery.bySetTimeDesc")
    : t("gallery.byTimeDesc")
);

const filterFoldLabel = computed(() => {
  void locale.value;
  if (isWallpaperOrderBrowse.value) return t("gallery.filterWallpaperSet");
  if (props.filter.type === "date-range") {
    return `${props.filter.start} ~ ${props.filter.end}`;
  }
  const dt = dateTail.value;
  if (dt) return t("gallery.filterByTimeWithDetail", { detail: dt });
  const pid = currentPluginId.value;
  if (pid) return t("gallery.filterByPluginWithName", { name: pluginStore.pluginLabel(pid) });
  const mk = filterMediaKind(props.filter);
  if (mk === "image") {
    const label = t("gallery.filterImageOnlyLabel");
    return isLazyLoaded("media-type") ? `${label} (${mediaTypeCounts.value.imageCount})` : label;
  }
  if (mk === "video") {
    const label = t("gallery.filterVideoOnlyLabel");
    return isLazyLoaded("media-type") ? `${label} (${mediaTypeCounts.value.videoCount})` : label;
  }
  return t("gallery.filterAll");
});

function onSortOrderChange(value: string) {
  const sort = value === "desc" ? "desc" : "asc";
  emit("update:sort", sort);
}

const sortToolbarButtonLabel = computed(() =>
  sortOrder.value === "desc" ? sortOptionLabelDesc.value : sortOptionLabelAsc.value
);

function onDesktopFilterCommand(cmd: string) {
  if (cmd !== "all" && cmd !== "wallpaper-order") return;
  emit(
    "update:filter",
    cmd === "all" ? { type: "all" } : { type: "wallpaper-order" }
  );
}

function onDesktopPluginFilterCommand(pluginId: string) {
  const id = (pluginId || "").trim();
  if (!id) return;
  emit("update:filter", { type: "plugin", pluginId: id });
}

function onDesktopTimeFilterCommand(seg: string) {
  const s = (seg || "").trim();
  if (!s) return;
  emit("update:filter", { type: "date", segment: s });
}

function onDesktopMediaTypeFilterCommand(kind: string) {
  if (kind !== "image" && kind !== "video") return;
  emit("update:filter", { type: "media-type", kind });
}

function onDesktopSortCommand(cmd: string) {
  if (cmd !== "asc" && cmd !== "desc") return;
  onSortOrderChange(cmd);
}

const pageSizeOptions = [100, 500, 1000] as const;
const pageSizeLabel = computed(() => String(props.pageSize));

async function onDesktopPageSizeCommand(cmd: string) {
  const n = Number(cmd);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  emit("update:pageSize", n);
}

// Android：fold 中过滤 / 排序弹出的 picker
const showFilterPicker = ref(false);
const showTimeFilterPicker = ref(false);
const showPluginFilterPicker = ref(false);
const showMediaTypeFilterPicker = ref(false);
const showSortPicker = ref(false);
const showPageSizePicker = ref(false);
useModalBack(showFilterPicker);
useModalBack(showTimeFilterPicker);
useModalBack(showPluginFilterPicker);
useModalBack(showMediaTypeFilterPicker);
useModalBack(showSortPicker);
useModalBack(showPageSizePicker);

const filterPickerColumns = computed(() => [
  { text: t("gallery.filterAll"), value: "all" },
  { text: t("gallery.filterWallpaperSet"), value: "wallpaper-order" },
  { text: t("gallery.filterByTime"), value: "time" },
  { text: t("gallery.filterByPlugin"), value: "plugin" },
  { text: t("gallery.filterByMediaType"), value: "media-type" },
]);
const filterPickerSelected = ref<string[]>(["all"]);
watch(showFilterPicker, (open) => {
  if (open) {
    if (isWallpaperOrderBrowse.value) {
      filterPickerSelected.value = ["wallpaper-order"];
    } else if (isTimeFilterBrowse.value) {
      filterPickerSelected.value = ["time"];
    } else if (isPluginFilterBrowse.value) {
      filterPickerSelected.value = ["plugin"];
    } else if (isMediaTypeFilterBrowse.value) {
      filterPickerSelected.value = ["media-type"];
    } else {
      filterPickerSelected.value = ["all"];
    }
  }
});
async function onFilterPickerConfirm() {
  showFilterPicker.value = false;
  const v = filterPickerSelected.value[0];
  if (v === "time") {
    await ensureTimeRootLoaded();
    await ensureTimeTailLoaded(dateTail.value);
    if (!timeMenuRoots.value.length) return;
    showTimeFilterPicker.value = true;
    return;
  }
  if (v === "plugin") {
    await ensurePluginGroupsLoaded();
    if (!pluginGroups.value.length) return;
    showPluginFilterPicker.value = true;
    return;
  }
  if (v === "media-type") {
    await ensureMediaTypeCountsLoaded();
    showMediaTypeFilterPicker.value = true;
    return;
  }
  if (v === "all" || v === "wallpaper-order") {
    emit(
      "update:filter",
      v === "all" ? { type: "all" } : { type: "wallpaper-order" }
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
  if (year) {
    await ensureTimeYearMonthsLoaded(year);
  }
  const yearMonth = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(s)?.[1];
  if (yearMonth) {
    await ensureTimeMonthDaysLoaded(yearMonth);
  }
}

watch(showTimeFilterPicker, (open) => {
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
  if (node) {
    await ensureTimeNodeChildrenLoaded(node);
  }
  applyTimeMenuPickerState(values);
}

function onTimeFilterPickerConfirm(payload: {
  selectedValues: (string | number)[];
}) {
  showTimeFilterPicker.value = false;
  const roots = timeMenuRoots.value;
  const tail = resolveTimeMenuPickToDateTail(
    roots,
    payload.selectedValues.map(String)
  );
  if (!tail) return;
  emit("update:filter", { type: "date", segment: tail });
}

const pluginFilterPickerColumns = computed(() => {
  void locale.value;
  return pluginGroups.value.map((g) => ({
    text: `${pluginStore.pluginLabel(g.plugin_id)} (${g.count})`,
    value: g.plugin_id,
  }));
});
const pluginFilterPickerSelected = ref<string[]>([]);
watch(showPluginFilterPicker, (open) => {
  if (open) {
    const id =
      currentPluginId.value ||
      pluginGroups.value[0]?.plugin_id ||
      "";
    pluginFilterPickerSelected.value = id ? [id] : [];
  }
});
function onPluginFilterPickerConfirm() {
  showPluginFilterPicker.value = false;
  const id = pluginFilterPickerSelected.value[0];
  if (!id) return;
  emit("update:filter", { type: "plugin", pluginId: id });
}

const mediaTypeFilterPickerColumns = computed(() => {
  void locale.value;
  const { imageCount, videoCount } = mediaTypeCounts.value;
  return [
    {
      text: `${t("gallery.filterImageOnly")} (${imageCount})`,
      value: "image",
    },
    {
      text: `${t("gallery.filterVideoOnly")} (${videoCount})`,
      value: "video",
    },
  ];
});
const mediaTypeFilterPickerSelected = ref<string[]>(["image"]);
watch(showMediaTypeFilterPicker, (open) => {
  if (open) {
    const k = filterMediaKind(props.filter);
    mediaTypeFilterPickerSelected.value = [k === "video" ? "video" : "image"];
  }
});
function onMediaTypeFilterPickerConfirm() {
  showMediaTypeFilterPicker.value = false;
  const kind = mediaTypeFilterPickerSelected.value[0];
  if (kind !== "image" && kind !== "video") return;
  emit("update:filter", { type: "media-type", kind });
}

const sortPickerColumns = computed(() => [
  { text: sortOptionLabelAsc.value, value: "asc" },
  { text: sortOptionLabelDesc.value, value: "desc" },
]);
const sortPickerSelected = ref<string[]>(["asc"]);
watch(showSortPicker, (open) => {
  if (open) sortPickerSelected.value = [sortOrder.value];
});
function onSortPickerConfirm() {
  showSortPicker.value = false;
  const v = sortPickerSelected.value[0];
  if (v === "asc" || v === "desc") onSortOrderChange(v);
}

const pageSizePickerColumns = computed(() =>
  pageSizeOptions.map((n) => ({ text: String(n), value: String(n) })),
);
const pageSizePickerSelected = ref<string[]>(["100"]);
watch(showPageSizePicker, (open) => {
  if (open) pageSizePickerSelected.value = [String(props.pageSize)];
});
async function onPageSizePickerConfirm() {
  showPageSizePicker.value = false;
  const v = pageSizePickerSelected.value[0];
  const n = Number(v);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  emit("update:pageSize", n);
}

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return t('gallery.noImages');
  }
  return t('gallery.totalImages', { count: props.totalCount });
});

const emit = defineEmits<{
  refresh: [];
  showHelp: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  openCollectMenu: [];
  "update:filter": [value: GalleryFilter];
  "update:sort": [value: GalleryTimeSort];
  "update:selectedRange": [value: [string, string] | null];
  "update:pageSize": [value: number];
  "update:search": [value: string];
}>();

const showIds = computed(() => {
  if (uiStore.isCompact) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [
    HeaderFeatureId.Refresh,
    HeaderFeatureId.Help,
    HeaderFeatureId.QuickSettings,
    HeaderFeatureId.Organize,
    HeaderFeatureId.FailedImages,
    HeaderFeatureId.TaskDrawer,
    HeaderFeatureId.Collect,
  ];
});

const foldIds = computed(() => {
  if (!uiStore.isCompact) return [HeaderFeatureId.ToggleShowHidden];
  const ids: HeaderFeatureId[] = [HeaderFeatureId.FailedImages];
  if (showGalleryFilterFold.value) {
    ids.push(HeaderFeatureId.GalleryFilter);
  }
  ids.push(HeaderFeatureId.GallerySort);
  ids.push(HeaderFeatureId.GalleryPageSize);
  ids.push(HeaderFeatureId.ToggleShowHidden);
  return ids;
});

const headerStore = useHeaderStore();
watch(
  [
    sortOrder,
    sortOptionLabelAsc,
    sortOptionLabelDesc,
    filterFoldLabel,
    showGalleryFilterFold,
    () => props.pageSize,
    () => failedImagesStore.allFailed.length,
    galleryHide,
  ],
  () => {
    headerStore.setFoldLabel(
      HeaderFeatureId.ToggleShowHidden,
      galleryHide.value ? t("header.showHidden") : t("header.hideHidden")
    );
    if (!uiStore.isCompact) return;
    headerStore.setFoldLabel(HeaderFeatureId.FailedImages, failedCountFoldLabel.value);
    if (showGalleryFilterFold.value) {
      headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, filterFoldLabel.value);
    } else {
      headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, undefined);
    }
    headerStore.setFoldLabel(
      HeaderFeatureId.GallerySort,
      sortOrder.value === "desc" ? sortOptionLabelDesc.value : sortOptionLabelAsc.value
    );
    headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, String(props.pageSize));
  },
  { immediate: true }
);
onUnmounted(() => {
  headerStore.setFoldLabel(HeaderFeatureId.ToggleShowHidden, undefined);
  if (!uiStore.isCompact) return;
  headerStore.setFoldLabel(HeaderFeatureId.FailedImages, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryFilter, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GallerySort, undefined);
  headerStore.setFoldLabel(HeaderFeatureId.GalleryPageSize, undefined);
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
        }
      }
      break;
    case HeaderFeatureId.Help:
      emit("showHelp");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("showQuickSettings");
      break;
    case HeaderFeatureId.GalleryFilter:
      showFilterPicker.value = true;
      break;
    case HeaderFeatureId.GallerySort:
      showSortPicker.value = true;
      break;
    case HeaderFeatureId.GalleryPageSize:
      pageSizePickerSelected.value = [String(props.pageSize)];
      showPageSizePicker.value = true;
      break;
    case HeaderFeatureId.Organize:
      // 整理由 header 的 OrganizeHeaderControl 处理，此处不会触发（Organize 在 show 中）
      break;
    case HeaderFeatureId.FailedImages:
      void router.push({ path: "/failed-images" });
      break;
    case HeaderFeatureId.ToggleShowHidden:
      galleryRouteStore.hide = !galleryRouteStore.hide;
      break;
  }
};
</script>

<style scoped lang="scss">
.gallery-browse-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.gallery-browse-btn {
  .gallery-browse-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}

.gallery-browse-search {
  margin-left: auto;
}

.date-range-filter {
  width: 260px;
  margin-left: 8px;
}

.add-task-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.plugin-submenu-wrap {
  padding: 0 !important;
}

.plugin-submenu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 16px;
  font-size: 14px;
  line-height: 22px;
  box-sizing: border-box;
  cursor: pointer;
}

.plugin-submenu-chevron {
  margin-left: 12px;
  font-size: 12px;
}

.plugin-submenu-menu {
  max-height: min(60vh, 360px);
  overflow-y: auto;
}

.plugin-count {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
