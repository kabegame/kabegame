<template>
  <div class="gallery-query-bar w-full min-w-0">
    <!-- 桌面：左端是行首插槽与排序，中段是简单 chip + 追加高级 chip 横向滚动区，右端钉
         着清除全部与 chip 自定义入口。
         chip 只写取值——维度由图标表明，维度名与取值一起进 tooltip（chipDisplay）。
         hugTop 收掉上方 PageHeader 那 20px 外边距的一大半，工具条贴近标题栏。 -->
    <div
      class="query-row mb-1 flex flex-wrap items-center gap-2"
      :class="{ '-mt-3': hugTop, 'is-compact': uiStore.isCompact }"
    >
      <!-- 页面自己的行首控件（如画册详情的「图片 / 子画册」选项卡）：
           挤在同一行省掉一整行高度。 -->
      <slot name="leading" />

      <!-- 排序 = 两颗纯图标 chip：先「按哪个维度」，再「往哪个方向」。两颗都不写字
           ——排序恒有值，写出来就是一段永远占位的常量；名字与取值全在 tooltip 里。 -->
      <KbFilterDropdown
        v-if="showSortFieldChip"
        :model-value="sortField"
        :options="sortFieldItems"
        :chip-label="t('gallery.sort')"
        chip-display="icon"
        :title="chipTitle(t('gallery.sort'), sortFieldChipValue)"
        :clearable="false"
        @update:model-value="
          (value) => {
            if (value) onSortFieldCommand(value);
          }
        "
      >
        <!-- 复合图标：底是通用的「排序」双箭头（一眼认出这颗管排序），
             右下角挂当前维度的小徽章（再认出按什么排）。只给维度图标的话，
             它和右侧同名的过滤维度长得一模一样，认不出是排序入口。 -->
        <template #icon>
          <span class="sort-combo">
            <Sort class="sort-combo__base" />
            <component :is="sortFieldIcon" class="sort-combo__badge" />
          </span>
        </template>
      </KbFilterDropdown>

      <KbFilterDropdown
        v-if="showSortOrderChip"
        :model-value="sortOrder"
        :chip-label="t('gallery.sortOrder')"
        :selected-label="sortOrderChipValue"
        chip-action="toggle"
        chip-display="icon"
        :title="chipTitle(t('gallery.sortOrder'), sortOrderToggleHint)"
        :clearable="false"
        @toggle="onSortOrderToggle"
      >
        <template #icon>
          <SortDesc v-if="sortOrder === 'desc'" />
          <SortAsc v-else />
        </template>
      </KbFilterDropdown>

      <span v-if="hasFixedSection" class="query-divider" />

      <!-- 桌面具体过滤行：与高级查询同一套 chip 下拉；整段横向滚动，不换行 -->
      <!-- el-scrollbar：滚动条是浮层不占位；view 的上下 padding 给 chip 右上角浮出的
           清除徽章留位置(overflow-x 会连带裁 y)，下边距同时让滑块不压住 chip。
           v-hscroll-fade 在两侧点亮「还有内容没滚到」的粉色渐隐。 -->
      <el-scrollbar
        v-hscroll-fade
        class="filter-chip-row query-main"
        view-class="flex flex-nowrap items-center gap-3 pt-2 pb-2.5"
      >
        <!-- 搜索与其它维度同列，与高级查询条件行共用同一个组件；
               这里每次提交都会 navigate + 重查，所以要防抖 -->
        <GallerySearchDropdown
          v-if="showSearchChip"
          :query="searchText"
          :selected-modes="searchModesView"
          :modes="searchFeatures"
          :chip-display="searchText.trim() ? 'value' : 'icon'"
          :debounce="300"
          @update:query="onSearchInput"
          @update:selected-modes="onSearchModesSelect"
        />

        <KbFilterDropdown
          v-for="dimension in filterDimensions"
          :key="dimension.key"
          :model-value="isDimensionActive(dimension.key) ? dimension.key : null"
          :chip-label="dimension.chipLabel"
          :selected-label="dimensionChipValue(dimension.key)"
          :any-label="dimension.anyLabel"
          :chip-display="isDimensionActive(dimension.key) ? 'value' : 'icon'"
          :title="chipTitle(dimension.title, dimensionChipTitleValue(dimension))"
          @open="setDimensionPopoverOpen(dimension.key, true)"
          @close="setDimensionPopoverOpen(dimension.key, false)"
          @update:model-value="
            (value) => {
              if (value === null) clearDimension(dimension.key);
            }
          "
        >
          <template #icon>
            <component :is="dimension.icon" />
          </template>
          <template #panel="{ close }">
            <!-- 面板顶层直接是本维度的子项：没有维度根，也没有「任意」行，清除本维度用 chip 右上角的叉号。
                   子项计数由 pathForTreeSegment 按「去掉本维度后」的上下文算出。 -->
            <div class="p-1.5">
              <GalleryFilterTree
                ref="providerTreeRef"
                :context-prefix="simpleContextPrefix"
                :filters="activeFilters"
                :filter="filterForDimension(activeFilters, dimension.key)"
                :dimension="dimension.key"
                :visible="!!dimensionPopoverOpen[dimension.key]"
                @update:filter="
                  (f) => {
                    onDimensionFilter(dimension.key, f);
                    close();
                  }
                "
              />
            </div>
          </template>
        </KbFilterDropdown>
        <KbFilterDropdown
          v-if="enableAdvanced"
          :model-value="isAdvancedActive ? 'advanced' : null"
          :chip-label="t('gallery.advancedQuery')"
          :selected-label="t('gallery.advancedQueryShort')"
          :badge="advancedConditionCount > 0 ? String(advancedConditionCount) : undefined"
          :any-label="t(isAdvancedActive ? 'gallery.advancedClear' : 'gallery.advancedQueryShort')"
          :title="t('gallery.advancedQuery')"
          chip-display="value"
          chip-action="toggle"
          @toggle="openAdvancedQuery"
          @update:model-value="clearAdvancedQuery"
        >
          <template #icon><LetterA /></template>
        </KbFilterDropdown>
      </el-scrollbar>

      <span class="query-divider" />

      <!-- 清除全部过滤。画廊把它放在标题副标题里（那里本来就在说「筛出了多少」），
           详情页没有那个位置，就钉在工具条右端，不随 chip 一起滚走。 -->
      <button
        v-if="enableClearAll && isFilterIndicatorActive"
        type="button"
        class="query-clear-filter flex-none"
        :title="t('gallery.clearAllFilters')"
        :aria-label="t('gallery.clearAllFilters')"
        @click="clearAllFilters"
      >
        <el-icon><Filter /></el-icon>
        <span class="query-clear-filter__badge">
          <el-icon><Close /></el-icon>
        </span>
      </button>

      <!-- chip 自定义入口：借 chip 下拉的弹层与开合逻辑，trigger 用 icon 档收成方形。
           它自己不是过滤维度，所以恒 clearable=false + model-value=null。 -->
      <KbFilterDropdown
        :model-value="null"
        :chip-label="t('gallery.chipSettings')"
        :title="t('gallery.chipSettings')"
        chip-display="icon"
        :clearable="false"
      >
        <template #icon><MoreFilled /></template>
        <template #panel>
          <div class="chip-settings">
            <!-- 顶部区域：视图级动作。「用当前视图轮播」把本视图（过滤 + 排序，不含分页）的
                 PathQL 路径设为壁纸轮播来源；设置页只展示当前轮播路径，入口在这里。 -->
            <template v-if="showRotationAction">
              <button
                type="button"
                class="chip-settings__action"
                :disabled="isRotatingThisView || rotationBusy"
                @click="rotateWithCurrentView"
              >
                <span class="chip-settings__icon"><Picture /></span>
                <span class="flex-1 text-left">
                  {{ isRotatingThisView ? t("gallery.rotatingThisView") : t("gallery.rotateThisView") }}
                </span>
              </button>
              <!-- 保存的过滤：预留区域，后续在这里列出用户保存的过滤设置 -->
              <div class="chip-settings__saved-filters" />
              <div class="chip-settings__divider" />
            </template>

            <template v-for="(group, index) in chipToggleGroups" :key="index">
              <div v-if="index > 0 && group.length" class="chip-settings__divider" />
              <div v-if="index === 0 && group.length" class="chip-settings__title">
                {{ t("gallery.chipVisibleTitle") }}
              </div>
              <div v-for="item in group" :key="item.key" class="chip-settings__row">
                <span class="chip-settings__icon"><component :is="item.icon" /></span>
                <span class="flex-1">{{ item.label }}</span>
                <el-switch
                  :model-value="isChipEnabled(item.key)"
                  size="small"
                  @update:model-value="(v) => saveChipSetting(item.key, !!v)"
                />
              </div>
            </template>

            <p class="chip-settings__help">{{ t("gallery.chipHiddenHelp") }}</p>
          </div>
        </template>
      </KbFilterDropdown>
    </div>

    <!-- Android：fold 中「每页条数」弹出的 van-picker（桌面工具条没有这颗 chip，改从设置页走） -->
    <Teleport v-if="uiStore.isCompact" to="body">
      <van-popup
        v-if="enablePageSize"
        :show="pageSizePicker.isOpen.value"
        position="bottom"
        round
        :z-index="pageSizePicker.zIndex.value"
        @update:show="pageSizePicker.close"
      >
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
      :context-prefix="advancedContextPrefix"
      @apply="applyAdvancedQuery"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, markRaw, provide, ref, useSlots, watch, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import { KbFilterDropdown, type KbFilterDropdownOption } from "@kabegame/element-plus";
import {
  Clock,
  Close,
  Filter,
  FilterAspect,
  FilterDate,
  FilterMedia,
  FilterName,
  FilterPlugin,
  FilterSize,
  FilterWallpaper,
  LetterA,
  List,
  MagicStick,
  MoreFilled,
  Picture,
  Rank,
  Search,
  Sort,
  SortAsc,
  SortDesc,
} from "@kabegame/element-plus-icons";
import { withGalleryPrefix } from "@/utils/path";
import GalleryFilterTree from "@/components/galleryFilterTree/GalleryFilterTree.vue";
import GalleryAdvancedQueryDialog from "@/components/gallery/GalleryAdvancedQueryDialog.vue";
import GallerySearchDropdown from "@/components/gallery/GallerySearchDropdown.vue";
import { GallerySearchModesKey } from "@/components/gallery/searchModesContext";
import { useModal } from "@/composables/useModal";
import { useUiStore } from "@/stores/ui";
import { useSettingsStore, type AppSettingKey } from "@/stores/settings";
import { usePluginStore } from "@/stores/plugins";
import {
  FILTER_COMB,
  filterForDimension,
  newRandomSortSeed,
  noAlbumContextPrefix,
  removeFilterDimension,
  setFilterDimension,
  type GalleryBrowseDimension,
  type GalleryFilter,
  type GalleryFilterSet,
  type GalleryQueryPatch,
  type GallerySearchPathMode,
  makeSearchTerm,
  type GallerySort,
  type GallerySortField,
} from "@/utils/galleryPath";
import { galleryDimensionChipValue, gallerySortFieldLabel } from "@/utils/galleryFilterLabels";
import { filterMediaKind } from "@/utils/galleryQuery";
import { viewRotationPath, wallpaperModeSupportsVideo } from "@/utils/wallpaperRotationPath";
import { gridViewPathKey } from "@/components/imageGrid/gridViewPath";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { IS_WEB } from "@/env";
import { DEFAULT_GALLERY_PAGE_SIZE, GALLERY_PAGE_SIZE_OPTIONS, isGalleryPageSizeOption } from "@/utils/galleryPageSize";
import {
  cloneQuery,
  composeQueryFilters,
  conditionCount,
  hasActiveQuery,
  queryFromFilterSet,
  serializeQueryBody,
  splitQueryFilters,
  type GalleryQuery,
} from "@/utils/galleryQuery";

/**
 * 画廊 / 画册详情 / 任务详情 / 畅游详情共用的查询行。
 *
 * 组件本身不认识任何 route store：所有会改变查询的动作都汇成一个 `navigate`
 * 事件（一次一个 patch），由各页把它转给自己的 path-route store。
 * 简单 chip 与追加高级条件只修改自己负责的部分，再合成同一份查询。
 */
interface Props {
  /** 唯一查询对象：首个原子为简单 chip，其余为追加高级条件。 */
  query?: GalleryQuery;
  /**
   * 随行上下文（全局工具箱开关）：用于简单与高级过滤的计数上下文。
   * 各页传自己 route store 的 `effectiveNoAlbum`——赦免该参数的路由（画册详情）
   * 拿到的恒为 false。
   */
  noAlbum?: boolean;
  sort?: GallerySort;
  pageSize?: number;
  /** 搜索词为空时搜索下拉勾选维度的兜底（各页的会话 sticky 勾选，默认全选；空 = 不过滤）。 */
  searchModes?: readonly GallerySearchPathMode[];
  /** 兼容调用侧的旧参数；计数上下文现由 contextBase + 两部分查询构造。 */
  providerContextPrefix?: string;
  /**
   * 高级查询路径的基址（含 `hide/` 与 `album/<id>` 这类根前缀，**不含 search**）：
   * route store 的 `contextPathFor({ query: [] })`。查询体（含搜索原子）由本组件
   * 自己拼进去，基址里再带一份会重复。
   */
  contextBase?: string;
  filterFeatures?: GalleryBrowseDimension[];
  sortFeatures?: GallerySortField[];
  /** 搜索 chip 可见的目标 tab；任务/畅游详情传基础三项。 */
  searchFeatures?: readonly GallerySearchPathMode[];
  enableSearch?: boolean;
  enablePageSize?: boolean;
  /** 是否提供追加高级条件的 chip 与弹窗 */
  enableAdvanced?: boolean;
  /** 在过滤行右端提供「清除全部过滤」（画廊把它放在副标题里，故传 false） */
  enableClearAll?: boolean;
  /** 紧贴上方标题栏：收掉 PageHeader 的下外边距 */
  hugTop?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  query: () => [],
  noAlbum: false,
  sort: () => ({ field: "by-id", desc: false }) as GallerySort,
  pageSize: DEFAULT_GALLERY_PAGE_SIZE,
  searchModes: () => ["display-name", "local-path", "url", "metadata", "native-metadata", "label"],
  providerContextPrefix: "",
  contextBase: "",
  // withDefaults 的工厂会被提升到 setup 外，只能写字面量：引用模块内常量会编译失败。
  filterFeatures: () => ["date", "plugin", "mediaType", "aspect", "size"],
  sortFeatures: () => ["by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time", "random"],
  searchFeatures: () => ["display-name", "local-path", "url", "metadata", "native-metadata", "label"],
  enableSearch: true,
  enablePageSize: true,
  enableAdvanced: true,
  enableClearAll: false,
  hugTop: false,
});

const emit = defineEmits<{
  navigate: [patch: GalleryQueryPatch, options?: { push?: boolean }];
  /** 搜索维度勾选变化（含搜索词为空时）：各页借此维护会话 sticky 勾选。 */
  searchModesChange: [modes: GallerySearchPathMode[]];
}>();

const { t, locale } = useI18n();
const slots = useSlots();
const uiStore = useUiStore();
const pluginStore = usePluginStore();
const settingsStore = useSettingsStore();

const queryParts = computed(() => splitQueryFilters(props.query));
const activeFilters = computed(() => queryParts.value.simple);
const advancedQuery = computed(() => queryParts.value.advanced);
const sortField = computed<GallerySortField>(() => props.sort.field);
const sortOrder = computed<"asc" | "desc">(() => (props.sort.desc ? "desc" : "asc"));

// 高级弹窗内的搜索 chip（ConditionRow）通过 inject 拿这份可见集合，不逐层透传。
provide(
  GallerySearchModesKey,
  computed(() => props.searchFeatures),
);

const labelContext = computed(() => ({
  t,
  locale: String(locale.value),
  pluginLabel: (id: string) => pluginStore.pluginLabel(id),
}));

// ---------- 用当前视图轮播 ----------
const rotationBusy = ref(false);
// 所在 ImageGrid 注入的当前视图路径；不在 ImageGrid 插槽里则不提供该动作
const gridViewPath = inject(gridViewPathKey, null);
const rotationPath = computed(() => (gridViewPath?.value ? viewRotationPath(gridViewPath.value) : ""));
const showRotationAction = computed(() => !IS_WEB && !!rotationPath.value);
const isRotatingThisView = computed(
  () =>
    !!settingsStore.values.wallpaperRotationEnabled &&
    settingsStore.values.wallpaperRotationPath === rotationPath.value,
);

async function rotateWithCurrentView() {
  const path = rotationPath.value;
  if (!path || rotationBusy.value) return;
  rotationBusy.value = true;
  try {
    // 先换路径再开启：开启时直接按新路径拉起轮播
    if (!(await settingsStore.save("wallpaperRotationPath", path))) return;
    if (!settingsStore.values.wallpaperRotationEnabled) await settingsStore.save("wallpaperRotationEnabled", true);
    // 原生壁纸只能显示图片：后端有效路径会追加图片过滤（见 rotator 的 wallpaper_file_available），
    // 这里直接看过滤对象是否已限定为图片，没有就提示视频会被跳过
    const skipsVideo =
      !wallpaperModeSupportsVideo(settingsStore.values.wallpaperMode) &&
      filterMediaKind(activeFilters.value) !== "image";
    if (skipsVideo) ElMessage.warning(t("gallery.rotateThisViewSkipsVideo"));
    else ElMessage.success(t("gallery.rotateThisViewSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e));
  } finally {
    rotationBusy.value = false;
  }
}

function navigate(patch: GalleryQueryPatch, options?: { push?: boolean }) {
  emit("navigate", patch, options);
}

// ---------- 搜索（查询原子的 search 维度）----------
const searchTerm = computed(() => activeFilters.value.search ?? null);
const searchText = computed(() => searchTerm.value?.query ?? "");
/**
 * 展示勾选：有搜索词跟词走，没有用各页传入的 sticky 兜底。sticky 默认全选，受限页
 * 与可见集合取交集；用户主动全不选（sticky 为空）时保持为空 = 不做搜索过滤。
 */
const searchModesView = computed<GallerySearchPathMode[]>(() => {
  if (searchTerm.value) return searchTerm.value.modes;
  if (props.searchModes.length === 0) return [];
  const visible = props.searchModes.filter((mode) => props.searchFeatures.includes(mode));
  return visible.length > 0 ? visible : [...props.searchFeatures];
});

/** 按给定输入与勾选重写简单 chip 的搜索维度；未勾选任何维度时搜索不进查询。 */
function navigateSearch(query: string, modes: readonly GallerySearchPathMode[]) {
  const next = { ...activeFilters.value };
  if (query.trim() && modes.length > 0) {
    next.search = makeSearchTerm(modes, query);
  } else {
    delete next.search;
  }
  navigate({ query: composeQueryFilters(next, advancedQuery.value) });
}

function onSearchInput(value: string) {
  // 全不选时输入只留在输入框里，不构成条件；本来就没有搜索条件时不必重查。
  if (searchModesView.value.length === 0 && !searchTerm.value) return;
  navigateSearch(value, searchModesView.value);
}

/** 勾选变化带上输入框里的当前内容：全不选时搜索已从查询里移除，重新勾选要靠它恢复。 */
function onSearchModesSelect(modes: GallerySearchPathMode[], query: string) {
  emit("searchModesChange", modes);
  // 有输入时勾选是查询的一部分，改勾选即改查询；空输入时只记 sticky。
  if (query.trim() || searchTerm.value) navigateSearch(query, modes);
}

// ---------- 追加高级条件 ----------
const isAdvancedActive = computed(() => hasActiveQuery(advancedQuery.value));
const advancedConditionCount = computed(() => conditionCount(advancedQuery.value));

/** 固定另一部分作为计数上下文，编辑器只读写自身条件。 */
function contextWithQuery(query: GalleryQuery): string {
  const part = serializeQueryBody(query);
  const base = `${withGalleryPrefix(props.contextBase)}/${noAlbumContextPrefix(props.noAlbum)}`;
  return part.body ? `${base}${part.body}/${part.endsAtHub ? "" : `${FILTER_COMB}/`}` : base;
}

const simpleContextPrefix = computed(() => contextWithQuery(composeQueryFilters({}, advancedQuery.value)));
const advancedContextPrefix = computed(() => `images://${contextWithQuery(queryFromFilterSet(activeFilters.value))}`);

const advancedDialogVisible = ref(false);
const advancedDialogInitialQuery = ref<GalleryQuery>([]);

function openAdvancedQuery() {
  advancedDialogInitialQuery.value = cloneQuery(advancedQuery.value);
  advancedDialogVisible.value = true;
}

function applyAdvancedQuery(tree: GalleryQuery) {
  navigate({ query: composeQueryFilters(activeFilters.value, tree) }, { push: true });
}

function clearAdvancedQuery() {
  navigate({ query: queryFromFilterSet(activeFilters.value) }, { push: true });
}

// ---------- 过滤维度 chip ----------
// 搜索有独立输入组件（GallerySearchDropdown），不进图标表。
// 过滤维度图标与高级查询弹窗同源(设计稿那套 16px 线性图标)。
const FILTER_DIMENSION_ICONS: Record<GalleryBrowseDimension, Component> = {
  plugin: markRaw(FilterPlugin),
  mediaType: markRaw(FilterMedia),
  date: markRaw(FilterDate),
  size: markRaw(FilterSize),
  aspect: markRaw(FilterAspect),
};

const ALL_FILTER_DIMENSIONS: Array<{
  key: GalleryBrowseDimension;
  titleKey: string;
  chipKey: string;
  /** 未选中态的 chip 文案。chip 上没有维度名了，所以「任意」必须自带维度。 */
  anyKey: string;
  setting: ChipSettingKey;
}> = [
  {
    key: "date",
    titleKey: "gallery.filterByTime",
    chipKey: "gallery.advancedChipTime",
    anyKey: "gallery.filterAnyTime",
    setting: "galleryChipDate",
  },
  {
    key: "plugin",
    titleKey: "gallery.filterByPlugin",
    chipKey: "gallery.advancedChipPlugin",
    anyKey: "gallery.filterAnyPlugin",
    setting: "galleryChipPlugin",
  },
  {
    key: "mediaType",
    titleKey: "gallery.filterByMediaType",
    chipKey: "gallery.advancedChipMediaType",
    anyKey: "gallery.filterAnyMediaType",
    setting: "galleryChipMediaType",
  },
  {
    key: "aspect",
    titleKey: "gallery.filterByAspect",
    chipKey: "gallery.advancedChipAspect",
    anyKey: "gallery.filterAnyAspect",
    setting: "galleryChipAspect",
  },
  {
    key: "size",
    titleKey: "gallery.filterBySize",
    chipKey: "gallery.advancedChipSize",
    anyKey: "gallery.filterAnySize",
    setting: "galleryChipSize",
  },
];

/**
 * 本页开放、且用户没在 ⋯ 面板里关掉的过滤维度。
 *
 * 关掉的维度只要**当前真的在过滤**就强行显示：否则查询被一条看不见的条件夹着，
 * 人既不知道为什么少了图，也没地方把它清掉。
 */
const filterDimensions = computed<
  Array<{
    key: GalleryBrowseDimension;
    title: string;
    chipLabel: string;
    anyLabel: string;
    icon: Component;
  }>
>(() =>
  ALL_FILTER_DIMENSIONS.filter(
    (d) => props.filterFeatures.includes(d.key) && (isChipEnabled(d.setting) || isDimensionActive(d.key)),
  ).map((d) => ({
    key: d.key,
    title: t(d.titleKey),
    chipLabel: t(d.chipKey),
    anyLabel: t(d.anyKey),
    icon: FILTER_DIMENSION_ICONS[d.key],
  })),
);

// ---------- 工具条 chip：显隐与信息密度 ----------
/**
 * 每颗 chip 一个 `galleryChip*` 设置键（localStorage 后端），在 ⋯ 面板里直接开关。
 *
 * 读取一律「非 false 即显示」：设置还没落盘（新装、或后来新增的维度）时应当先把
 * chip 显出来，而不是让人对着一条空工具条去找开关。
 */
type ChipSettingKey = Extract<AppSettingKey, `galleryChip${string}`>;

function isChipEnabled(key: ChipSettingKey) {
  return settingsStore.values[key] !== false;
}

function saveChipSetting(key: ChipSettingKey, value: boolean) {
  void settingsStore.save(key, value);
}

/** tooltip 文案：chip 上一律不写维度名，全靠这里补回来。 */
function chipTitle(label: string, value?: string) {
  return value ? `${label} · ${value}` : label;
}

function dimensionChipTitleValue(dimension: { key: GalleryBrowseDimension; anyLabel: string }) {
  return isDimensionActive(dimension.key) ? dimensionChipValue(dimension.key) : dimension.anyLabel;
}

/** 搜索同理：关掉的搜索框只要还兜着关键词，就得留在条上让人看得见、清得掉。 */
const showSearchChip = computed(
  () => props.enableSearch && (isChipEnabled("galleryChipSearch") || !!searchText.value.trim()),
);
const showSortFieldChip = computed(() => props.sortFeatures.length > 0 && isChipEnabled("galleryChipSortField"));
const showSortOrderChip = computed(() => props.sortFeatures.length > 0 && isChipEnabled("galleryChipSortOrder"));

/** 左端固定区是否有内容——空的话它后面那条分隔线就成了行首一根孤立竖线。 */
const hasFixedSection = computed(() => !!slots.leading || showSortFieldChip.value || showSortOrderChip.value);

/**
 * 排序维度的图标。纯图标 chip 下，通用的「排序」双箭头说不出到底按什么排，
 * 所以每个维度用它自己那张脸——与同名过滤维度共用一张，认过一次就都认得。
 */
const SORT_FIELD_ICONS: Record<GallerySortField, Component> = {
  "by-id": markRaw(Rank),
  "by-time": markRaw(Clock),
  "by-size": markRaw(FilterSize),
  "by-name": markRaw(FilterName),
  "by-aspect": markRaw(FilterAspect),
  "by-set-time": markRaw(FilterWallpaper),
  "by-album-order": markRaw(List),
  random: markRaw(MagicStick),
};

const sortFieldIcon = computed<Component>(() => SORT_FIELD_ICONS[sortField.value] ?? markRaw(Sort));
const sortFieldChipValue = computed(() => gallerySortFieldLabel(sortField.value, t));
const sortOrderChipValue = computed(() => (props.sort.desc ? t("gallery.sortDescending") : t("gallery.sortAscending")));
/** 顺序 chip 点了就翻，tooltip 得把「翻过去是什么」说清楚。 */
const sortOrderToggleHint = computed(() =>
  t("gallery.sortOrderToggle", {
    current: sortOrderChipValue.value,
    next: props.sort.desc ? t("gallery.sortAscending") : t("gallery.sortDescending"),
  }),
);

interface ChipToggleItem {
  key: ChipSettingKey;
  label: string;
  icon: Component;
}

/**
 * ⋯ 面板里的 chip 开关，分两组：随查询变化的过滤维度，和恒定的排序 / 每页。
 * 只列本页真的会渲染的 chip——页面本就没开的维度，给个开关也开不出东西来。
 */
const chipToggleGroups = computed<ChipToggleItem[][]>(() => {
  const filters: ChipToggleItem[] = [];
  if (props.enableSearch) {
    filters.push({
      key: "galleryChipSearch",
      label: t("gallery.advancedChipSearch"),
      icon: markRaw(Search),
    });
  }
  for (const d of ALL_FILTER_DIMENSIONS) {
    if (!props.filterFeatures.includes(d.key)) continue;
    filters.push({ key: d.setting, label: t(d.chipKey), icon: FILTER_DIMENSION_ICONS[d.key] });
  }

  const tools: ChipToggleItem[] = [];
  if (props.sortFeatures.length > 0) {
    tools.push(
      { key: "galleryChipSortField", label: t("gallery.sort"), icon: markRaw(Sort) },
      { key: "galleryChipSortOrder", label: t("gallery.sortOrder"), icon: markRaw(SortAsc) },
    );
  }

  return [filters, tools];
});

const dimensionPopoverOpen = ref<Partial<Record<GalleryBrowseDimension, boolean>>>({});

function setDimensionPopoverOpen(dimension: GalleryBrowseDimension, open: boolean) {
  dimensionPopoverOpen.value = { ...dimensionPopoverOpen.value, [dimension]: open };
}

function closeDimensionPopover(dimension: GalleryBrowseDimension) {
  setDimensionPopoverOpen(dimension, false);
}

function isDimensionActive(dimension: GalleryBrowseDimension) {
  return filterForDimension(activeFilters.value, dimension).type !== "all";
}

function dimensionChipValue(dimension: GalleryBrowseDimension) {
  return galleryDimensionChipValue(dimension, activeFilters.value, labelContext.value);
}

/** 更新简单维度，保留当前搜索词和追加高级条件。 */
function applyFilters(filters: GalleryFilterSet) {
  const next = { ...filters };
  if (searchTerm.value?.query.trim()) {
    next.search = searchTerm.value;
  } else {
    delete next.search;
  }
  navigate({ query: composeQueryFilters(next, advancedQuery.value) }, { push: true });
}

function clearDimension(dimension: GalleryBrowseDimension) {
  applyFilters(removeFilterDimension(activeFilters.value, dimension));
  closeDimensionPopover(dimension);
}

function onDimensionFilter(dimension: GalleryBrowseDimension, filter: GalleryFilter) {
  applyFilters(setFilterDimension(activeFilters.value, dimension, filter));
  closeDimensionPopover(dimension);
}

// no-album 是工具箱的手动开关，与 hide 并列的路由上下文：天然不在查询里。
const isFilterIndicatorActive = computed(() => hasActiveQuery(props.query));

function clearAllFilters() {
  navigate({ query: [] }, { push: true });
  dimensionPopoverOpen.value = {};
}

// ---------- 排序 / 每页条数 ----------
const sortFieldItems = computed<KbFilterDropdownOption[]>(() =>
  props.sortFeatures.map((field) => ({
    label: gallerySortFieldLabel(field, t),
    value: field,
  })),
);

// 工具条没有每页条数 chip（改从设置页与安卓 picker 走）；这里只留 picker 用的候选。
const pageSizeOptions = GALLERY_PAGE_SIZE_OPTIONS;

function onSortFieldCommand(cmd: string) {
  if (!props.sortFeatures.includes(cmd as GallerySortField)) return;
  if (cmd === "random") {
    // 已处于随机也重新洗牌：不做 already-active 提前返回。
    navigate({ sort: { field: "random", desc: props.sort.desc, seed: newRandomSortSeed() } });
    return;
  }
  navigate({ sort: { field: cmd as GallerySortField, desc: props.sort.desc } });
}

function onSortOrderToggle() {
  navigate({ sort: { ...props.sort, desc: !props.sort.desc } });
}

// 过滤行的横向滚动渐隐 + 滚轮接管统一走 v-hscroll-fade 指令（directives/hscrollFade.ts）

// 插件被卸载/更新：当前按已不存在的插件过滤时清掉这一维度，否则查询被一条
// 看不见来源的条件夹着。
const pluginSignature = computed(() => pluginStore.plugins.map((p) => `${p.id}:${p.version}`).join("|"));
watch(pluginSignature, () => {
  const current = activeFilters.value.plugin?.pluginId ?? "";
  if (current && !pluginStore.plugins.some((p) => p.id === current)) {
    clearDimension("plugin");
  }
});

const providerTreeRef = ref<any>(null);

// ---------- 安卓 picker（每页条数）----------
const pageSizePicker = useModal();
const pageSizePickerColumns = computed(() => pageSizeOptions.map((n) => ({ text: String(n), value: String(n) })));

const pageSizePickerSelected = ref<string[]>([String(DEFAULT_GALLERY_PAGE_SIZE)]);
watch(pageSizePicker.isOpen, (open) => {
  if (open) pageSizePickerSelected.value = [String(props.pageSize)];
});

function onPageSizePickerConfirm() {
  pageSizePicker.close();
  const v = pageSizePickerSelected.value[0];
  const n = Number(v);
  if (!isGalleryPageSizeOption(n)) return;
  void settingsStore.save("galleryPageSize", n);
}

// ---------- 对外接口 ----------
async function refreshProviderFilterTree() {
  const target = Array.isArray(providerTreeRef.value) ? providerTreeRef.value[0] : providerTreeRef.value;
  await target?.refresh?.();
}

function openPageSizePicker() {
  pageSizePickerSelected.value = [String(props.pageSize)];
  pageSizePicker.open();
}

defineExpose({
  openPageSizePicker,
  openAdvancedQuery,
  refreshProviderFilterTree,
});
</script>

<style scoped lang="scss">
/* chip 38px + 滚动区上下留白，查询改变时保持行高稳定。 */
.query-row {
  min-height: 56px;
}

/* 中段 chip 滚动区。
   `min-width` 是这里的关键：它既是「至少露出一颗 chip」的下限，也是换行的触发器
   —— flex 只按 flex-basis 与 min-width 决定断行，basis 为 0 且能缩到 0 时，中段会
   在窄容器里被挤成 0 宽却仍留在第一行，整段 chip 就这么凭空消失了（画册详情中栏
   两侧面板全开时正好如此）。给了下限，装不下就整段掉到第二行，退化成改版前那种
   两行布局，而宽屏下依旧是一行。 */
.query-main {
  flex: 1 1 12rem;
  min-width: 12rem;
}

/* 紧凑模式整行就是屏宽，没有被侧栏挤窄的问题；12rem 的下限在手机上反而会把
   chip 区或行末 ⋯ 挤到第二行。这里不换行，中段从 0 起伸缩，装不下就横向滚动。 */
.query-row.is-compact {
  flex-wrap: nowrap;

  .query-main {
    flex: 1 1 0;
    min-width: 0;
  }
}

/* 分区竖线：把「看哪一批」的固定控件、随查询变化的 chip、行末工具三段隔开。
   高度只取 22px（不占满行），一整行下来是三段轻分隔而不是三个格子。 */
.query-divider {
  flex: none;
  width: 1px;
  height: 22px;
  background: var(--anime-border);
}

/* 排序维度 chip 的复合图标：通用排序双箭头打底 + 右下角的维度小徽章。
   徽章故意越出 15px 的图标盒（chip 是 38px 方块，右下有的是空地），
   否则挤在盒内两个图形都缩到看不清；一圈同色底把它和底图分开。
   选择器带 `.sort-combo` 前缀是为了压过 theme-chalk 里
   `__chip-icon svg { width:100%; height:100% }` 那条（scoped 属性再加一层特异性）。 */
.sort-combo {
  position: relative;
  display: inline-flex;
  width: 100%;
  height: 100%;
}

.sort-combo__base {
  width: 100%;
  height: 100%;
}

.sort-combo .sort-combo__badge {
  position: absolute;
  right: -4px;
  bottom: -4px;
  box-sizing: content-box;
  width: 9px;
  height: 9px;
  padding: 1px;
  border-radius: 50%;
  background: var(--anime-bg-card);
}

/* ⋯ 面板：与 chip 下拉共用弹层外壳，这里只排版内容。
   自己铺一层不透明底——共用弹层那档半透明是给「压在缩略图上的过滤树」调的，
   开关清单是表单，底下透出画作会让人分不清哪个开关是开的。 */
.chip-settings {
  display: flex;
  width: 268px;
  max-width: calc(100vw - 32px);
  flex-direction: column;
  padding: 10px;
  background: var(--anime-bg-card);
}

/* 行距压到刚够点：清单有近十行，每行多 3px 面板就高出一大截，
   最后要么顶出视口要么盖住半个画廊。 */
.chip-settings__row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 3px 8px;
  border-radius: 8px;
  font-size: 13px;
}

.chip-settings__icon {
  display: inline-flex;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--anime-secondary);

  :deep(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
}

.chip-settings__title {
  padding: 2px 8px 4px;
  color: var(--anime-text-secondary);
  font-size: 12px;
}

.chip-settings__help {
  margin: 0;
  padding: 4px 8px 0;
  color: var(--anime-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.chip-settings__action {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--anime-text-primary);
  font-size: 13px;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--anime-primary) 8%, var(--anime-bg-card));
  }

  &:disabled {
    color: var(--anime-text-secondary);
    cursor: default;
  }
}

.chip-settings__divider {
  height: 1px;
  margin: 5px 4px;
  background: var(--anime-border);
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
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease;

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
