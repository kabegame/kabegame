<template>
  <div class="gallery-query-bar w-full min-w-0">
    <!-- 桌面：过滤入口(简单/高级) + 排序维度 / 顺序 / 每页条数。
         hugTop 收掉上方 PageHeader 那 20px 外边距的一大半，两行贴近标题栏。 -->
    <div
      v-if="!uiStore.isCompact"
      class="flex flex-wrap items-center gap-2"
      :class="{ '-mt-3': hugTop }"
    >
      <!-- 页面自己的行首控件（如画册详情的「图片 / 子画册」选项卡）：
           它和过滤模式一样是「看哪一批」的开关，挤在同一行省掉一整行高度。 -->
      <slot name="leading" />

      <!-- 过滤入口:简单 / 高级 二选一,下面那行跟着换 -->
      <KbTab
        v-if="enableAdvanced"
        v-model="filterMode"
        :items="filterModeItems"
        class="flex-none"
        @select="onFilterModeSelect"
      />

      <!-- 排序维度 / 顺序 / 每页条数：与过滤维度同一套 chip 下拉，区别只是必选
           (clearable=false：没有「任意」行、不出清除徽章、chip 不进选中高亮态)。 -->
      <KbFilterDropdown
        v-if="sortFeatures.length > 0"
        :model-value="sortField"
        :options="sortFieldItems"
        :chip-label="t('gallery.sort')"
        :clearable="false"
        class="flex-none"
        @update:model-value="(value) => { if (value) onSortFieldCommand(value); }"
      >
        <template #icon><Sort /></template>
      </KbFilterDropdown>

      <KbFilterDropdown
        v-if="sortFeatures.length > 0"
        :model-value="sortOrder"
        :options="sortOrderItems"
        :chip-label="t('gallery.sortOrder')"
        :clearable="false"
        class="flex-none"
        @update:model-value="(value) => { if (value) onSortOrderChange(value); }"
      >
        <template #icon>
          <Sort :class="{ 'rotate-180': sortOrder === 'desc' }" />
        </template>
      </KbFilterDropdown>

      <KbFilterDropdown
        v-if="enablePageSize"
        :model-value="String(pageSize)"
        :options="pageSizeItems"
        :chip-label="t('gallery.pageSize')"
        :clearable="false"
        class="flex-none"
        @update:model-value="(value) => { if (value) onPageSizeCommand(value); }"
      >
        <template #icon><Histogram /></template>
      </KbFilterDropdown>
    </div>

    <!-- 查询行：简单/高级共用同一个容器与同一档行高（按简单态的 chip 行算），
         否则两种模式高度不同，切换时下面的画廊会整体上下跳。 -->
    <div v-if="!uiStore.isCompact" class="query-row mb-1 flex items-center gap-2">
      <!-- 高级过滤:简单过滤那些维度整行不渲染,只留 pathql 路径与配置入口 -->
      <PathqlPathBar v-if="filterMode === 'advanced'" :path="advancedPathPreview" class="flex-1">
        <template #prefix>
          <el-button type="primary" class="flex-none" @click="openAdvancedQuery">
            <el-icon class="mr-1.5 text-sm"><Setting /></el-icon>
            {{ t("gallery.advancedConfigure") }}
          </el-button>
        </template>
      </PathqlPathBar>

      <!-- 桌面具体过滤行：与高级查询同一套 chip 下拉；整行横向滚动，不换行 -->
      <!-- el-scrollbar：滚动条是浮层不占位；view 的上下 padding 给 chip 右上角浮出的
           清除徽章留位置(overflow-x 会连带裁 y)，下边距同时让滑块不压住 chip。
           右边界的粉色渐隐只在还能往右滚时出现，提示「后面还有」。 -->
      <div
        v-else
        class="filter-chip-viewport relative min-w-0 flex-1"
        :class="{ 'has-more': chipRowHasMore }"
      >
        <el-scrollbar
          ref="filterChipScrollRef"
          class="filter-chip-row"
          view-class="flex flex-nowrap items-center gap-3 pt-2 pb-2.5"
          @scroll="updateChipRowOverflow"
          @wheel="onFilterChipWheel"
        >
          <!-- 搜索与其它维度同列，与高级查询条件行共用同一个组件；
               这里每次提交都会 navigate + 重查，所以要防抖 -->
          <GallerySearchDropdown
            v-if="enableSearch"
            :query="search"
            :mode="searchMode"
            :modes="searchFeatures"
            :debounce="300"
            @update:query="(value) => navigate({ search: value, page: 1 })"
            @update:mode="(mode) => navigate({ searchMode: mode, page: 1 })"
          />

          <KbFilterDropdown
            v-for="dimension in filterDimensions"
            :key="dimension.key"
            :model-value="isDimensionActive(dimension.key) ? dimension.key : null"
            :chip-label="dimension.chipLabel"
            :selected-label="dimensionChipValue(dimension.key)"
            :any-label="t('gallery.filterAny')"
            :title="dimension.title"
            @open="setDimensionPopoverOpen(dimension.key, true)"
            @close="setDimensionPopoverOpen(dimension.key, false)"
            @update:model-value="(value) => { if (value === null) clearDimension(dimension.key); }"
          >
            <template #icon>
              <component :is="dimension.icon" />
            </template>
            <template #panel="{ close }">
              <!-- 「任意」不再手写：树自己的 AnyProviderChildrenNode 就是它，
                   而且带计数（pathForTreeSegment 对单维度的 all 段会算「去掉本维度后」的总数）。 -->
              <div class="p-1.5">
                <GalleryFilterTree
                  ref="providerTreeRef"
                  :context-prefix="providerContextPrefix"
                  :filters="activeFilters"
                  :filter="filterForDimension(activeFilters, dimension.key)"
                  :dimension="dimension.key"
                  :visible="!!dimensionPopoverOpen[dimension.key]"
                  @update:filter="(f) => { onDimensionFilter(dimension.key, f); close(); }"
                />
              </div>
            </template>
          </KbFilterDropdown>
        </el-scrollbar>
      </div>

      <!-- 清除全部过滤。画廊把它放在标题副标题里（那里本来就在说「筛出了多少」），
           详情页没有那个位置，就钉在过滤行右端，不随 chip 一起滚走。 -->
      <button
        v-if="enableClearAll && filterMode === 'simple' && isFilterIndicatorActive"
        type="button"
        class="query-clear-filter flex-none"
        :title="t('gallery.clearAllFilters')"
        :aria-label="t('gallery.clearAllFilters')"
        @click="clearAllFilters"
      >
        <el-icon><Filter /></el-icon>
        <span class="query-clear-filter__badge"><el-icon><Close /></el-icon></span>
      </button>
    </div>

    <!-- 紧凑模式没有上面那行，行首控件与「高级查询」按钮共用这一行 -->
    <div
      v-if="uiStore.isCompact && (enableAdvanced || !!$slots.leading)"
      class="mb-2 flex items-center gap-2"
    >
      <slot name="leading" />
      <el-button
        v-if="enableAdvanced"
        class="ml-auto"
        size="small"
        :class="{
          '!border-[rgba(255,107,157,0.55)] !bg-[rgba(255,107,157,0.12)] !text-[var(--anime-primary)]': isAdvancedActive,
        }"
        @click="openAdvancedQuery"
      >
        <el-icon class="mr-1"><Filter /></el-icon>
        {{ t("gallery.advancedQueryShort") }}
        <span v-if="advancedConditionCount > 0" class="ml-1 rounded-full bg-[var(--anime-primary)] px-1.5 text-[10px] text-white">
          {{ advancedConditionCount }}
        </span>
      </el-button>
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

    <GalleryAdvancedQueryDialog
      v-if="enableAdvanced"
      v-model:visible="advancedDialogVisible"
      :query="advancedDialogInitialQuery"
      :sort="sort"
      :page="page"
      :page-size="pageSize"
      :context-prefix="advancedDialogContextPrefix"
      @apply="applyAdvancedQuery"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, onUnmounted, provide, ref, watch, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  KbFilterDropdown,
  KbTab,
  type KbFilterDropdownOption,
  type KbTabItem,
} from "@kabegame/element-plus";
import {
  Close,
  Filter,
  FilterAspect,
  FilterDate,
  FilterMedia,
  FilterName,
  FilterPlugin,
  FilterSize,
  FilterWallpaper,
  Histogram,
  Setting,
  Sort,
} from "@kabegame/element-plus-icons";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { pathqlEntry, pathqlList } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";
import GalleryFilterTree from "@/components/galleryFilterTree/GalleryFilterTree.vue";
import GalleryAdvancedQueryDialog from "@/components/gallery/GalleryAdvancedQueryDialog.vue";
import PathqlPathBar from "@/components/gallery/PathqlPathBar.vue";
import GallerySearchDropdown from "@/components/gallery/GallerySearchDropdown.vue";
import { GallerySearchModesKey } from "@/components/gallery/searchModesContext";
import { useModal } from "@kabegame/core/composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import { usePluginStore } from "@/stores/plugins";
import { useImagesChangeRefresh, type ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import {
  GALLERY_ASPECT_BUCKETS,
  GALLERY_NAME_LANGUAGE_BUCKETS,
  DEFAULT_GALLERY_SEARCH_MODE,
  advancedQueryRuntimePath,
  buildAdvancedQueryContextPrefix,
  buildComposablePath,
  filterAspectRange,
  filterDateSegment,
  filterForDimension,
  filterMediaKind,
  filterNameBucket,
  filterPluginId,
  hasActiveGalleryFilters,
  newRandomSortSeed,
  removeFilterDimension,
  setFilterDimension,
  singleFilterToSet,
  type GalleryFilter,
  type GalleryFilterDimension,
  type GalleryFilterSet,
  type GalleryQueryPatch,
  type GallerySearchMode,
  type GallerySort,
  type GallerySortField,
} from "@/utils/galleryPath";
import {
  galleryDimensionChipValue,
  gallerySortFieldLabel,
  gallerySortOrderLabels,
} from "@/utils/galleryFilterLabels";
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
import {
  advancedQueryFromSimpleFilters,
  conditionCount,
  normalizeQuery,
  simpleFiltersFromAdvancedQuery,
  type GalleryAdvancedQuery,
} from "@/utils/galleryQuery";

/**
 * 画廊 / 画册详情 / 任务详情 / 畅游详情共用的查询行。
 *
 * 组件本身不认识任何 route store：所有会改变查询的动作都汇成一个 `navigate`
 * 事件（一次一个 patch），由各页把它转给自己的 path-route store。这样
 * 「切回简单过滤时把树降级平移」这类**必须原子完成**的多字段改动，才不会被
 * 拆成多次导航互相覆盖。
 */
interface Props {
  filters?: GalleryFilterSet;
  /** 已应用的高级查询树；undefined = 当前不是高级模式 */
  advanced?: GalleryAdvancedQuery;
  sort?: GallerySort;
  page?: number;
  pageSize?: number;
  search?: string;
  /** 搜索目标：display-name(显示名) | metadata(插件元数据) | native-metadata(EXIF/PNG) */
  searchMode?: GallerySearchMode;
  /** provider 树 / facet 计数的上下文前缀：route store 的 `computedContextPath` */
  providerContextPrefix?: string;
  /**
   * 高级查询路径的基址（含 `hide/` 与 `album/<id>` 这类根前缀，**不含 search**）：
   * route store 的 `contextPathFor({ search: "" })`。search 由本组件按当前模式
   * 自己拼进去，基址里再带一份会重复。
   */
  contextBase?: string;
  filterFeatures?: GalleryFilterDimension[];
  sortFeatures?: GallerySortField[];
  /** 搜索 chip 可见的目标 tab；任务/畅游详情传基础三项。 */
  searchFeatures?: readonly GallerySearchMode[];
  enableSearch?: boolean;
  enablePageSize?: boolean;
  /** 是否提供「简单 / 高级」入口与高级查询弹窗 */
  enableAdvanced?: boolean;
  /** 在过滤行右端提供「清除全部过滤」（画廊把它放在副标题里，故传 false） */
  enableClearAll?: boolean;
  /** 紧贴上方标题栏：收掉 PageHeader 的下外边距 */
  hugTop?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  filters: () => ({} as GalleryFilterSet),
  advanced: undefined,
  sort: () => ({ field: "by-id", desc: false } as GallerySort),
  page: 1,
  pageSize: 100,
  search: "",
  searchMode: DEFAULT_GALLERY_SEARCH_MODE,
  providerContextPrefix: "",
  contextBase: "",
  // withDefaults 的工厂会被提升到 setup 外，只能写字面量：引用模块内常量会编译失败。
  filterFeatures: () => [
    "date",
    "plugin",
    "mediaType",
    "aspect",
    "size",
    "name",
    "wallpaperOrder",
  ],
  sortFeatures: () => [
    "by-id",
    "by-time",
    "by-size",
    "by-name",
    "by-aspect",
    "by-set-time",
    "random",
  ],
  searchFeatures: () => [
    "display-name",
    "local-path",
    "url",
    "metadata",
    "native-metadata",
  ],
  enableSearch: true,
  enablePageSize: true,
  enableAdvanced: true,
  enableClearAll: false,
  hugTop: false,
});

const emit = defineEmits<{
  navigate: [patch: GalleryQueryPatch, options?: { push?: boolean }];
}>();

const { t, locale } = useI18n();
const uiStore = useUiStore();
const pluginStore = usePluginStore();

const activeFilters = computed<GalleryFilterSet>(() => props.filters ?? {});
const sortField = computed<GallerySortField>(() => props.sort.field);
const sortOrder = computed<"asc" | "desc">(() => (props.sort.desc ? "desc" : "asc"));
const searchMode = computed<GallerySearchMode>(() => props.searchMode);

// 高级弹窗内的搜索 chip（ConditionRow）通过 inject 拿这份可见集合，不逐层透传。
provide(GallerySearchModesKey, computed(() => props.searchFeatures));

const labelContext = computed(() => ({
  t,
  locale: String(locale.value),
  pluginLabel: (id: string) => pluginStore.pluginLabel(id),
}));

function navigate(patch: GalleryQueryPatch, options?: { push?: boolean }) {
  emit("navigate", patch, options);
}

/** 只留 no-album 这个随行上下文：它是工具箱的手动开关，不算用户过滤。 */
function contextOnlyFilters(): GalleryFilterSet {
  return activeFilters.value.noAlbum ? { noAlbum: true } : {};
}

// ---------- 简单 / 高级 ----------
/**
 * 过滤入口是二选一:简单维度行 与 高级查询树在路由上互斥,但切换本身尽量不丢查询——
 * 简单 → 高级:什么都不动(简单过滤会成为高级路径的上下文前缀,点「配置」再翻译进树);
 * 高级 → 简单:树能被简单过滤表达就平移过去,表达不了(含 或/非/多条件)才清空。
 */
type FilterMode = "simple" | "advanced";
const filterMode = ref<FilterMode>("simple");
/** 切走高级时把树留在本地,再切回来「配置」还能接着 editing(不是已应用状态)。 */
const stashedAdvanced = ref<GalleryAdvancedQuery | null>(null);

const isAdvancedActive = computed(() => props.advanced !== undefined);
const advancedConditionCount = computed(() => conditionCount(props.advanced ?? []));

const filterModeItems = computed<KbTabItem<FilterMode>[]>(() => [
  {
    name: "simple",
    label: t("gallery.filterModeSimple"),
    icon: markRaw(Filter),
  },
  {
    name: "advanced",
    label: t("gallery.filterModeAdvanced"),
    icon: markRaw(Filter),
    count: advancedConditionCount.value > 0 ? advancedConditionCount.value : null,
  },
]);

watch(
  isAdvancedActive,
  (active) => {
    if (active) filterMode.value = "advanced";
  },
  { immediate: true },
);

// 页面换了数据源（切画册 / 切任务）时回到简单态：树是跟着路径走的，不该跨源残留。
watch(
  () => props.contextBase,
  () => {
    if (!isAdvancedActive.value) filterMode.value = "simple";
  },
);

/** `images://gallery[/hide][/album/<id>]` —— 高级路径与 facet 的共同基址。 */
const providerBase = computed(() => `images://${withGalleryPrefix(props.contextBase)}`);

const advancedContextPrefix = computed(
  () =>
    `${providerBase.value}/${
      buildAdvancedQueryContextPrefix(
        activeFilters.value,
        props.search,
        props.searchMode,
      )
    }`,
);

/**
 * 弹窗里的上下文前缀只保留「应用后仍然生效」的部分：应用高级查询会接管
 * 简单过滤与搜索（见 applyAdvancedQuery），所以它们不能再算进前缀，
 * 否则弹窗里的条件会与前缀里的同一条件重复。
 */
const advancedDialogContextPrefix = computed(
  () =>
    `${providerBase.value}/${buildAdvancedQueryContextPrefix(contextOnlyFilters(), "")}`,
);

const advancedPathPreview = computed(() =>
  advancedQueryRuntimePath(
    buildComposablePath({
      filters: {},
      advanced: props.advanced ?? [],
      sort: props.sort,
      page: props.page,
      pageSize: props.pageSize,
    }),
    advancedContextPrefix.value,
  ),
);

const advancedDialogVisible = ref(false);
const advancedDialogInitialQuery = ref<GalleryAdvancedQuery>([{ is: {} }]);

function openAdvancedQuery() {
  // 优先已应用的树 → 切模式时暂存的树 → 由当前简单过滤(含搜索)翻译一行
  const source = props.advanced ?? stashedAdvanced.value;
  if (source) {
    advancedDialogInitialQuery.value = JSON.parse(
      JSON.stringify(source),
    ) as GalleryAdvancedQuery;
  } else {
    advancedDialogInitialQuery.value = advancedQueryFromSimpleFilters(
      activeFilters.value,
      props.search.trim()
        ? { mode: props.searchMode, query: props.search }
        : null,
    );
  }
  advancedDialogVisible.value = true;
}

function applyAdvancedQuery(tree: GalleryAdvancedQuery) {
  const normalized = normalizeQuery(tree);
  navigate(
    {
      advanced: normalized.length > 0 ? normalized : undefined,
      // 树接管简单过滤与搜索：弹窗初值已把它们复制进去，原件必须在同一次
      // navigate 里清掉，否则会与树里的同一条件叠加。
      filters: contextOnlyFilters(),
      search: "",
      searchMode: DEFAULT_GALLERY_SEARCH_MODE,
      page: 1,
    },
    { push: true },
  );
}

function onFilterModeSelect(mode: FilterMode) {
  // 简单过滤是高级路径的合法上下文前缀,切过去不用动任何状态。
  if (mode === "advanced") return;
  if (!isAdvancedActive.value) return;

  const advanced = props.advanced ?? [];
  stashedAdvanced.value = advanced;

  const degraded = simpleFiltersFromAdvancedQuery(advanced);
  if (!degraded) {
    // 或/非/多条件:简单过滤行表达不了,只能清空——这是丢查询,必须明说。
    ElMessage.warning(t("gallery.advancedQueryDropped"));
    navigate(
      {
        advanced: undefined,
        filters: contextOnlyFilters(),
        search: "",
        searchMode: DEFAULT_GALLERY_SEARCH_MODE,
        page: 1,
      },
      { push: true },
    );
    return;
  }

  navigate(
    {
      advanced: undefined,
      filters: { ...degraded.filters, ...contextOnlyFilters() },
      search: degraded.search?.query ?? "",
      searchMode: degraded.search?.mode ?? DEFAULT_GALLERY_SEARCH_MODE,
      page: 1,
    },
    { push: true },
  );
}

// ---------- 过滤维度 chip ----------
// no-album 不是可浏览过滤维度（不进过滤行 / 不显示图标），故从图标表中排除。
// 过滤维度图标与高级查询弹窗同源(设计稿那套 16px 线性图标)。
const FILTER_DIMENSION_ICONS: Record<Exclude<GalleryFilterDimension, "noAlbum">, Component> = {
  wallpaperOrder: markRaw(FilterWallpaper),
  plugin: markRaw(FilterPlugin),
  mediaType: markRaw(FilterMedia),
  date: markRaw(FilterDate),
  name: markRaw(FilterName),
  size: markRaw(FilterSize),
  aspect: markRaw(FilterAspect),
};

const ALL_FILTER_DIMENSIONS: Array<{
  key: Exclude<GalleryFilterDimension, "noAlbum">;
  titleKey: string;
  chipKey: string;
}> = [
  { key: "date", titleKey: "gallery.filterByTime", chipKey: "gallery.advancedChipTime" },
  { key: "plugin", titleKey: "gallery.filterByPlugin", chipKey: "gallery.advancedChipPlugin" },
  { key: "mediaType", titleKey: "gallery.filterByMediaType", chipKey: "gallery.advancedChipMediaType" },
  { key: "aspect", titleKey: "gallery.filterByAspect", chipKey: "gallery.advancedChipAspect" },
  { key: "size", titleKey: "gallery.filterBySize", chipKey: "gallery.advancedChipSize" },
  { key: "name", titleKey: "gallery.filterByName", chipKey: "gallery.advancedChipName" },
  { key: "wallpaperOrder", titleKey: "gallery.filterWallpaperSet", chipKey: "gallery.advancedChipWallpaper" },
];

const filterDimensions = computed<Array<{
  key: GalleryFilterDimension;
  title: string;
  chipLabel: string;
  icon: Component;
}>>(() =>
  ALL_FILTER_DIMENSIONS
    .filter((d) => props.filterFeatures.includes(d.key))
    .map((d) => ({
      key: d.key,
      title: t(d.titleKey),
      chipLabel: t(d.chipKey),
      icon: FILTER_DIMENSION_ICONS[d.key],
    })),
);

const dimensionPopoverOpen = ref<Partial<Record<GalleryFilterDimension, boolean>>>({});

function setDimensionPopoverOpen(dimension: GalleryFilterDimension, open: boolean) {
  dimensionPopoverOpen.value = { ...dimensionPopoverOpen.value, [dimension]: open };
}

function closeDimensionPopover(dimension: GalleryFilterDimension) {
  setDimensionPopoverOpen(dimension, false);
}

function isDimensionActive(dimension: GalleryFilterDimension) {
  return filterForDimension(activeFilters.value, dimension).type !== "all";
}

function dimensionChipValue(dimension: GalleryFilterDimension) {
  return galleryDimensionChipValue(dimension, activeFilters.value, labelContext.value);
}

/** 应用一次简单过滤：与高级查询互斥，故一并清掉树。 */
function applyFilters(filters: GalleryFilterSet) {
  navigate({ filters, advanced: undefined, page: 1 }, { push: true });
}

function clearDimension(dimension: GalleryFilterDimension) {
  applyFilters(removeFilterDimension(activeFilters.value, dimension));
  closeDimensionPopover(dimension);
}

function onDimensionFilter(dimension: GalleryFilterDimension, filter: GalleryFilter) {
  applyFilters(setFilterDimension(activeFilters.value, dimension, filter));
  closeDimensionPopover(dimension);
}

// no-album 是工具箱的手动开关，不算「过滤」维度：不点亮指示、也不被清除。
const isFilterIndicatorActive = computed(
  () =>
    !!props.search.trim() ||
    hasActiveGalleryFilters({ ...activeFilters.value, noAlbum: undefined }),
);

function clearAllFilters() {
  navigate(
    {
      filters: contextOnlyFilters(),
      advanced: undefined,
      search: "",
      searchMode: DEFAULT_GALLERY_SEARCH_MODE,
      page: 1,
    },
    { push: true },
  );
  dimensionPopoverOpen.value = {};
}

// ---------- 排序 / 每页条数 ----------
const sortFieldItems = computed<KbFilterDropdownOption[]>(() =>
  props.sortFeatures.map((field) => ({
    label: gallerySortFieldLabel(field, t),
    value: field,
  })),
);

const sortOrderItems = computed<KbFilterDropdownOption[]>(() => [
  { label: t("gallery.sortDescending"), value: "desc" },
  { label: t("gallery.sortAscending"), value: "asc" },
]);

const pageSizeOptions = [100, 500, 1000] as const;

const pageSizeItems = computed<KbFilterDropdownOption[]>(() =>
  pageSizeOptions.map((n) => ({ label: String(n), value: String(n) })),
);

function onSortFieldCommand(cmd: string) {
  if (!props.sortFeatures.includes(cmd as GallerySortField)) return;
  if (cmd === "random") {
    // 已处于随机也重新洗牌：不做 already-active 提前返回。
    navigate({ sort: { field: "random", desc: props.sort.desc, seed: newRandomSortSeed() } });
    return;
  }
  navigate({ sort: { field: cmd as GallerySortField, desc: props.sort.desc } });
}

function onSortOrderChange(value: string) {
  navigate({ sort: { ...props.sort, desc: value === "desc" } });
}

function onPageSizeCommand(cmd: string) {
  const n = Number(cmd);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  navigate({ pageSize: n, page: 1 });
}

// ---------- 过滤行横向滚动 ----------
const filterChipScrollRef = ref<{ wrapRef?: HTMLElement } | null>(null);
/** 过滤行右侧还有没滚到的 chip：用来点亮右边界那道粉色渐隐。 */
const chipRowHasMore = ref(false);

function updateChipRowOverflow() {
  const wrap = filterChipScrollRef.value?.wrapRef;
  if (!wrap) {
    chipRowHasMore.value = false;
    return;
  }
  chipRowHasMore.value = wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft > 1;
}

// 切换过滤模式会重建这段 DOM，observer 得跟着重绑；同时观察 view，
// chip 增减(如清除按钮出现)也要重算「右边还有没有」。
let chipRowResizeObserver: ResizeObserver | null = null;

function bindChipRowObserver() {
  chipRowResizeObserver?.disconnect();
  const wrap = filterChipScrollRef.value?.wrapRef;
  if (!wrap) {
    chipRowHasMore.value = false;
    return;
  }
  chipRowResizeObserver = new ResizeObserver(updateChipRowOverflow);
  chipRowResizeObserver.observe(wrap);
  if (wrap.firstElementChild) chipRowResizeObserver.observe(wrap.firstElementChild);
  updateChipRowOverflow();
}

watch(
  [filterMode, () => uiStore.isCompact],
  () => void nextTick(bindChipRowObserver),
);
onMounted(() => void nextTick(bindChipRowObserver));
onUnmounted(() => chipRowResizeObserver?.disconnect());

/**
 * 鼠标滚轮在过滤行上转成横向滚动：竖向滚轮本身不会驱动横向溢出，
 * 不接管的话这行看着能滚却滚不动（只有触控板横扫有效）。
 */
function onFilterChipWheel(event: WheelEvent) {
  const wrap = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
    ".el-scrollbar__wrap",
  );
  if (!wrap) return;

  const maxScroll = wrap.scrollWidth - wrap.clientWidth;
  if (maxScroll <= 0) return;

  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (!delta) return;

  const next = Math.min(Math.max(wrap.scrollLeft + delta, 0), maxScroll);
  if (next === wrap.scrollLeft) return; // 已到端点：让页面继续接管滚动
  event.preventDefault();
  wrap.scrollLeft = next;
}

// ---------- 懒加载（安卓 picker 的候选与计数）----------
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
const providerTreeRef = ref<any>(null);
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

/** 当前上下文前缀：hide + 根前缀 + search，由各页 route store 统一拼出。 */
const filterContextPrefix = computed(() => props.providerContextPrefix);

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
  pluginExtendChildren.value = {};
  mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
  yearGroups.value = [];
  monthGroups.value = [];
  dayGroups.value = [];
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

function parsePluginExtendScope(scope: string) {
  const raw = scope.slice("plugin-extend:".length);
  const tab = raw.indexOf("\t");
  if (tab < 0) return { pluginId: raw, extendPath: "" };
  return { pluginId: raw.slice(0, tab), extendPath: raw.slice(tab + 1) };
}

function loadedPluginExtendScopes() {
  const prefix = `${filterContextPrefix.value}|plugin-extend:`;
  return [...lazyLoadedKeys.value]
    .filter((key) => key.startsWith(prefix))
    .map((key) => parsePluginExtendScope(key.slice(prefix.length)))
    .filter((scope) => scope.pluginId);
}

function imageChangePluginIds(payload: ImagesChangePayload) {
  const ids = (payload.pluginIds ?? []).map((id) => id.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

async function markFilterLazyDataDirty(payload: ImagesChangePayload = {}) {
  const changedPluginIds = imageChangePluginIds(payload);
  const shouldReloadPlugins = isLazyLoaded("plugin");
  const shouldReloadPluginExtends = loadedPluginExtendScopes().filter(
    ({ pluginId }) => !changedPluginIds || changedPluginIds.has(pluginId),
  );
  const nextDirty = new Set(lazyDirtyKeys.value);
  const currentPrefix = `${filterContextPrefix.value}|`;
  for (const key of lazyLoadedKeys.value) {
    if (!key.startsWith(currentPrefix)) continue;
    const scope = key.slice(currentPrefix.length);
    if (!scope.startsWith("plugin-extend:")) {
      nextDirty.add(key);
      continue;
    }
    const { pluginId } = parsePluginExtendScope(scope);
    if (!changedPluginIds || changedPluginIds.has(pluginId)) {
      nextDirty.add(key);
    }
  }
  lazyDirtyKeys.value = nextDirty;
  if (changedPluginIds) {
    const nextChildren = { ...pluginExtendChildren.value };
    for (const key of Object.keys(nextChildren)) {
      const { pluginId } = parsePluginExtendKey(key);
      if (changedPluginIds.has(pluginId)) delete nextChildren[key];
    }
    pluginExtendChildren.value = nextChildren;
  } else {
    pluginExtendChildren.value = {};
  }
  if (shouldReloadPlugins) {
    await ensurePluginGroupsLoaded();
  }
  await Promise.all(
    shouldReloadPluginExtends.map(({ pluginId, extendPath }) =>
      ensurePluginExtendLoaded(pluginId, extendPath)
    ),
  );
}

useImagesChangeRefresh({
  enabled: ref(true),
  waitMs: 500,
  onRefresh: markFilterLazyDataDirty,
});

const pluginSignature = computed(() =>
  pluginStore.plugins.map((p) => `${p.id}:${p.version}`).join("|")
);

function resetPluginLazyData() {
  for (const timer of lazyLoadingTimers.values()) {
    clearTimeout(timer);
  }
  lazyLoadingTimers.clear();
  for (const key of [...lazyInFlight.keys()]) {
    if (key.includes("|plugin")) lazyInFlight.delete(key);
  }
  lazyLoadedKeys.value = new Set([...lazyLoadedKeys.value].filter((key) => !key.includes("|plugin")));
  lazyDirtyKeys.value = new Set([...lazyDirtyKeys.value].filter((key) => !key.includes("|plugin")));
  lazyPendingKeys.value = new Set([...lazyPendingKeys.value].filter((key) => !key.includes("|plugin")));
  lazyVisibleLoadingKeys.value = new Set(
    [...lazyVisibleLoadingKeys.value].filter((key) => !key.includes("|plugin"))
  );
  pluginGroups.value = [];
  pluginExtendChildren.value = {};
}

watch(pluginSignature, () => {
  const shouldReloadPlugins = isLazyLoaded("plugin");
  resetPluginLazyData();
  const current = activeFilters.value.plugin?.pluginId ?? "";
  if (current && !pluginStore.plugins.some((p) => p.id === current)) {
    clearDimension("plugin");
    return;
  }
  if (shouldReloadPlugins) {
    void ensurePluginGroupsLoaded();
  }
});

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
      if (prefix !== filterContextPrefix.value) return;
      pluginGroups.value = groups.filter((r) => r.count > 0);
    } catch {
      if (prefix === filterContextPrefix.value) pluginGroups.value = [];
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

function isProviderPlain(entry: ProviderChildDir) {
  return entry.meta?.plain === true;
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
      if (prefix !== filterContextPrefix.value) return;
      pluginExtendChildren.value = {
        ...pluginExtendChildren.value,
        [pluginExtendKey(id, path)]: entries,
      };
    } catch {
      if (prefix === filterContextPrefix.value) {
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
        )
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
          })),
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
          })),
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
          })),
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

// ---------- 安卓 picker ----------
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

const PICKER_DIMENSIONS: Array<{
  value: string;
  key: Exclude<GalleryFilterDimension, "noAlbum">;
  labelKey: string;
}> = [
  { value: "time", key: "date", labelKey: "gallery.filterByTime" },
  { value: "plugin", key: "plugin", labelKey: "gallery.filterByPlugin" },
  { value: "media-type", key: "mediaType", labelKey: "gallery.filterByMediaType" },
  { value: "aspect", key: "aspect", labelKey: "gallery.filterByAspect" },
  { value: "name", key: "name", labelKey: "gallery.filterByName" },
  { value: "wallpaper-order", key: "wallpaperOrder", labelKey: "gallery.filterWallpaperSet" },
];

const filterPickerColumns = computed(() => [
  { text: t("gallery.filterAll"), value: "all" },
  ...PICKER_DIMENSIONS
    .filter((d) => props.filterFeatures.includes(d.key))
    .map((d) => ({ text: t(d.labelKey), value: d.value })),
]);

const filterPickerSelected = ref<string[]>(["all"]);
watch(filterPicker.isOpen, (open) => {
  if (!open) return;
  if (isWallpaperOrderBrowse.value) filterPickerSelected.value = ["wallpaper-order"];
  else if (isTimeFilterBrowse.value) filterPickerSelected.value = ["time"];
  else if (isPluginFilterBrowse.value) filterPickerSelected.value = ["plugin"];
  else if (isMediaTypeFilterBrowse.value) filterPickerSelected.value = ["media-type"];
  else if (isNameBrowse.value) filterPickerSelected.value = ["name"];
  else if (isAspectBrowse.value) filterPickerSelected.value = ["aspect"];
  else filterPickerSelected.value = ["all"];
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
    applyFilters(v === "all" ? contextOnlyFilters() : { ...contextOnlyFilters(), wallpaperOrder: true });
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

function onTimeFilterPickerConfirm(payload: { selectedValues: (string | number)[] }) {
  timeFilterPicker.close();
  const tail = resolveTimeMenuPickToDateTail(
    timeMenuRoots.value,
    payload.selectedValues.map(String),
  );
  if (!tail) return;
  applyFilters({
    ...contextOnlyFilters(),
    ...singleFilterToSet({ type: "date", segment: tail }),
  });
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

function pluginExtendChildByPath(pluginId: string, extendPath = "") {
  const segments = normalizeExtendPath(extendPath).split("/").filter(Boolean);
  let parentPath = "";
  let found: ProviderChildDir | undefined;
  for (const segment of segments) {
    found = (pluginExtendChildren.value[pluginExtendKey(pluginId, parentPath)] ?? []).find(
      (child) => child.name === segment,
    );
    if (!found) return undefined;
    parentPath = [parentPath, segment].filter(Boolean).join("/");
  }
  return found;
}

function isPluginCommandPlain(command: string) {
  const { pluginId, extendPath } = parsePluginCommand(command);
  if (!pluginId || !extendPath) return false;
  const child = pluginExtendChildByPath(pluginId, extendPath);
  return child ? isProviderPlain(child) : false;
}

const pluginFilterPickerSelected = ref<string[]>([]);
watch(pluginFilterPicker.isOpen, (open) => {
  if (!open) return;
  const id = currentPluginId.value || pluginGroups.value[0]?.plugin_id || "";
  const extendPath = activeFilters.value.plugin?.extendPath ?? "";
  pluginFilterPickerSelected.value = id ? [id, pluginCommand(id, extendPath)] : [];
});

function onPluginFilterPickerConfirm() {
  const selected = pluginFilterPickerSelected.value;
  const command = selected[selected.length - 1] ?? "";
  if (isPluginCommandPlain(command)) return;
  pluginFilterPicker.close();
  const { pluginId: id, extendPath } = parsePluginCommand(command);
  if (!id) return;
  applyFilters({
    ...contextOnlyFilters(),
    ...singleFilterToSet(
      extendPath ? { type: "plugin", pluginId: id, extendPath } : { type: "plugin", pluginId: id },
    ),
  });
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
  if (!open) return;
  const k = filterMediaKind(activeFilters.value);
  mediaTypeFilterPickerSelected.value = [k === "video" ? "video" : "image"];
});

function onMediaTypeFilterPickerConfirm() {
  mediaTypeFilterPicker.close();
  const kind = mediaTypeFilterPickerSelected.value[0];
  if (kind !== "image" && kind !== "video") return;
  applyFilters({
    ...contextOnlyFilters(),
    ...singleFilterToSet({ type: "media-type", kind }),
  });
}

const nameFilterPickerColumns = computed(() =>
  GALLERY_NAME_LANGUAGE_BUCKETS.map((b) => ({ text: b.autonym, value: b.bucket })),
);

const nameFilterPickerSelected = ref<string[]>(["english"]);
watch(nameFilterPicker.isOpen, (open) => {
  if (!open) return;
  nameFilterPickerSelected.value = [
    filterNameBucket(activeFilters.value) ?? GALLERY_NAME_LANGUAGE_BUCKETS[0].bucket,
  ];
});

function onNameFilterPickerConfirm() {
  nameFilterPicker.close();
  const bucket = nameFilterPickerSelected.value[0]?.trim();
  if (!bucket) return;
  applyFilters({
    ...contextOnlyFilters(),
    ...singleFilterToSet({ type: "name", bucket }),
  });
}

const aspectFilterPickerColumns = computed(() =>
  GALLERY_ASPECT_BUCKETS.map((b) => ({ text: t(`gallery.${b.labelKey}`), value: b.range })),
);

const aspectFilterPickerSelected = ref<string[]>([GALLERY_ASPECT_BUCKETS[0].range]);
watch(aspectFilterPicker.isOpen, (open) => {
  if (!open) return;
  aspectFilterPickerSelected.value = [
    filterAspectRange(activeFilters.value) ?? GALLERY_ASPECT_BUCKETS[0].range,
  ];
});

function onAspectFilterPickerConfirm() {
  aspectFilterPicker.close();
  const range = aspectFilterPickerSelected.value[0]?.trim();
  if (!range) return;
  applyFilters({
    ...contextOnlyFilters(),
    ...singleFilterToSet({ type: "aspect", range }),
  });
}

const sortPickerColumns = computed(() => {
  const labels = gallerySortOrderLabels(sortField.value, t);
  return [
    { text: labels.asc, value: "asc" },
    { text: labels.desc, value: "desc" },
  ];
});

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
  navigate({ pageSize: n, page: 1 });
}

// ---------- 对外接口（安卓折叠菜单从各页 header 触发）----------
async function refreshProviderFilterTree() {
  const target = Array.isArray(providerTreeRef.value)
    ? providerTreeRef.value[0]
    : providerTreeRef.value;
  await target?.refresh?.();
}

function openFilterPicker() {
  // 高级查询生效时简单过滤入口整体失效：两者在路由上互斥。
  if (isAdvancedActive.value) return;
  filterPicker.open();
}

function openSortPicker() {
  sortPicker.open();
}

function openPageSizePicker() {
  pageSizePickerSelected.value = [String(props.pageSize)];
  pageSizePicker.open();
}

defineExpose({
  openFilterPicker,
  openSortPicker,
  openPageSizePicker,
  openAdvancedQuery,
  refreshProviderFilterTree,
});
</script>

<style scoped lang="scss">
/* 简单/高级共用的查询行：行高钉死在简单态的尺寸（chip 38px + 滚动区上下 8/10px 留白），
   高级态内容更矮时靠 align-items 居中撑住，切模式时下方画廊不会上下跳。 */
.query-row {
  min-height: 56px;
}

/* 过滤 chip 一整行横向滚动：chip 一律不压缩，否则窄屏下每个 chip 的值都被裁成半个字。 */
.filter-chip-row {
  // el-scrollbar 的滑块是浮层不占位，配色跟应用主色系走。
  --el-scrollbar-bg-color: var(--anime-primary);
  --el-scrollbar-hover-bg-color: var(--anime-primary-dark, var(--anime-primary));
  --el-scrollbar-opacity: 0.6;
  --el-scrollbar-hover-opacity: 0.95;

  :deep(.el-scrollbar__view) > * {
    flex: none;
  }

  :deep(.el-scrollbar__bar.is-horizontal) {
    height: 4px;
    bottom: 0;
    left: 0;
    right: 0;
  }
}

/* 右边界的粉色渐隐：还能往右滚时才出现，提示「后面还有维度」。 */
.filter-chip-viewport::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 36px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s ease;
  background: linear-gradient(
    to right,
    rgba(255, 107, 157, 0) 0%,
    rgba(255, 107, 157, 0.18) 100%
  );
}

.filter-chip-viewport.has-more::after {
  opacity: 1;
}

/* 清除全部过滤：过滤图标本体 + 右上角浮出的 ✕ 徽章，形态沿用 chip 的清除徽章
   （KbFilterDropdown __clear），只是这里整颗都可点。与画廊副标题里那颗同款。 */
.query-clear-filter {
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

.query-clear-filter__badge {
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
