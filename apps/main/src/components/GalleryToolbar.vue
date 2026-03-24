<template>
  <PageHeader :title="$t('gallery.gallery')" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span>{{ totalCountText }}</span>
    </template>
  </PageHeader>

  <!-- 桌面：过滤（全部 / 壁纸 / 按时间嵌套 / 按插件）+ 排序（任意根路径），置于标题与分页器之间 -->
  <div v-if="!IS_ANDROID" class="gallery-browse-toolbar">
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
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isTimeFilterBrowse }"
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
                      @command="onDesktopTimeFilterCommand"
                    />
                  </template>
                  <el-dropdown-item v-else disabled>
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
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isPluginFilterBrowse }"
              >
                {{ t("gallery.filterByPlugin") }}
                <el-icon class="plugin-submenu-chevron">
                  <ArrowRight />
                </el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu class="plugin-submenu-menu">
                  <template v-if="pluginGroups.length">
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
                  <el-dropdown-item v-else disabled>
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
            >
              <span
                class="plugin-submenu-trigger"
                :class="{ 'is-active': isMediaTypeFilterBrowse }"
              >
                {{ t("gallery.filterByMediaType") }}
                <el-icon class="plugin-submenu-chevron">
                  <ArrowRight />
                </el-icon>
              </span>
              <template #dropdown>
                <el-dropdown-menu class="plugin-submenu-menu">
                  <el-dropdown-item
                    command="image"
                    :class="{
                      'is-active': galleryMediaKindFromRoot(filterPathRoot) === 'image',
                    }"
                  >
                    {{ t("gallery.filterImageOnly") }}
                    <span class="plugin-count">({{ mediaTypeCounts.imageCount }})</span>
                  </el-dropdown-item>
                  <el-dropdown-item
                    command="video"
                    :class="{
                      'is-active': galleryMediaKindFromRoot(filterPathRoot) === 'video',
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
  </div>

  <!-- Android：fold 中「过滤」「排序」弹出的 van-picker -->
  <Teleport v-if="IS_ANDROID" to="body">
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
import { computed, ref, watch, onUnmounted, onMounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { ArrowDown, ArrowRight, Filter, Histogram, Sort } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import {
  galleryDateTailFromRoot,
  galleryMediaKindFromRoot,
  galleryPathWithRootOnly,
  galleryPathWithSortOnly,
  galleryPluginIdFromRoot,
  parseGalleryPath,
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
  type GalleryTimeFilterPayload,
  type TimeMenuNode,
} from "@/utils/galleryTimeFilterMenu";
import GalleryTimeFilterSubmenu from "@/header/comps/GalleryTimeFilterSubmenu.vue";
import { usePluginStore } from "@/stores/plugins";

interface Props {
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  currentPosition?: number; // 当前位置（分页启用时使用）
  monthOptions?: string[];
  monthLoading?: boolean;
  selectedRange?: [string, string] | null; // YYYY-MM-DD
  /** 当前画廊 provider 路径，如 全部、全部/倒序、按时间/2024-01 */
  providerRootPath?: string;
  /** 当前完整 query.path（如 all/desc/3），切换排序时保留页码 */
  currentProviderPath?: string;
  /** 每页条数（与设置同步，用于工具栏展示） */
  pageSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  currentPosition: 1,
  monthOptions: () => [],
  monthLoading: false,
  selectedRange: null,
  providerRootPath: "",
  currentProviderPath: "",
  pageSize: 100,
});

const router = useRouter();
const sortOrder = computed(() =>
  props.providerRootPath.includes("/desc") ? "desc" : "asc"
);
const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const isWallpaperOrderBrowse = computed(() =>
  props.providerRootPath.startsWith("wallpaper-order")
);

const filterPathRoot = computed(() => {
  const path = props.currentProviderPath?.trim() || "all/1";
  return parseGalleryPath(path).root;
});

const currentPluginId = computed(() =>
  galleryPluginIdFromRoot(filterPathRoot.value)
);

const dateTail = computed(() => galleryDateTailFromRoot(filterPathRoot.value));

const isPluginFilterBrowse = computed(() => currentPluginId.value != null);

const isTimeFilterBrowse = computed(() => dateTail.value != null);

const isMediaTypeFilterBrowse = computed(
  () => galleryMediaKindFromRoot(filterPathRoot.value) != null
);

const isAllFilterBrowse = computed(
  () => filterPathRoot.value === "all"
);

const showGalleryFilterFold = computed(() => {
  const root = filterPathRoot.value;
  return (
    root === "all" ||
    root === "wallpaper-order" ||
    /^plugin\//i.test(root) ||
    /^date\//i.test(root) ||
    /^media-type\//i.test(root)
  );
});

interface PluginGroupRow {
  plugin_id: string;
  count: number;
}

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

const pluginGroups = ref<PluginGroupRow[]>([]);
const mediaTypeCounts = ref<GalleryMediaTypeCountsPayload>({
  imageCount: 0,
  videoCount: 0,
});
const monthGroups = ref<DateGroupRow[]>([]);
const dayGroups = ref<DayGroupRow[]>([]);

const timeMenuRoots = computed<TimeMenuNode[]>(() =>
  buildGalleryTimeMenuTree(
    monthGroups.value,
    dayGroups.value,
    buildTimeMenuScopeLabels(t, String(locale.value))
  )
);

onMounted(async () => {
  try {
    const [pg, timePayload, mt] = await Promise.all([
      invoke<PluginGroupRow[]>("get_gallery_plugin_groups"),
      invoke<GalleryTimeFilterPayload>("get_gallery_time_filter_data"),
      invoke<GalleryMediaTypeCountsPayload>("get_gallery_media_type_counts"),
      pluginStore.loadPlugins(),
    ]);
    pluginGroups.value = Array.isArray(pg) ? pg : [];
    monthGroups.value = Array.isArray(timePayload?.months) ? timePayload.months : [];
    dayGroups.value = Array.isArray(timePayload?.days) ? timePayload.days : [];
    if (mt && typeof mt.imageCount === "number" && typeof mt.videoCount === "number") {
      mediaTypeCounts.value = {
        imageCount: mt.imageCount,
        videoCount: mt.videoCount,
      };
    }
  } catch {
    pluginGroups.value = [];
    monthGroups.value = [];
    dayGroups.value = [];
  }
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
  const dt = dateTail.value;
  if (dt) return t("gallery.filterByTimeWithDetail", { detail: dt });
  const pid = currentPluginId.value;
  if (pid) return t("gallery.filterByPluginWithName", { name: pluginStore.pluginLabel(pid) });
  const mk = galleryMediaKindFromRoot(filterPathRoot.value);
  if (mk === "image") {
    return `${t("gallery.filterImageOnlyLabel")} (${mediaTypeCounts.value.imageCount})`;
  }
  if (mk === "video") {
    return `${t("gallery.filterVideoOnlyLabel")} (${mediaTypeCounts.value.videoCount})`;
  }
  return t("gallery.filterAll");
});

function onSortOrderChange(value: string) {
  const path = props.currentProviderPath?.trim() || "all/1";
  const sort = value === "desc" ? "desc" : "asc";
  const next = galleryPathWithSortOnly(path, sort);
  void router.push({ path: "/gallery", query: { path: next } });
}

const sortToolbarButtonLabel = computed(() =>
  sortOrder.value === "desc" ? sortOptionLabelDesc.value : sortOptionLabelAsc.value
);

function onDesktopFilterCommand(cmd: string) {
  if (cmd !== "all" && cmd !== "wallpaper-order") return;
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, cmd);
  void router.push({ path: "/gallery", query: { path: next } });
}

function onDesktopPluginFilterCommand(pluginId: string) {
  const id = (pluginId || "").trim();
  if (!id) return;
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `plugin/${id}`);
  void router.push({ path: "/gallery", query: { path: next } });
}

function onDesktopTimeFilterCommand(seg: string) {
  const s = (seg || "").trim();
  if (!s) return;
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `date/${s}`);
  void router.push({ path: "/gallery", query: { path: next } });
}

function onDesktopMediaTypeFilterCommand(kind: string) {
  if (kind !== "image" && kind !== "video") return;
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `media-type/${kind}`);
  void router.push({ path: "/gallery", query: { path: next } });
}

function onDesktopSortCommand(cmd: string) {
  if (cmd !== "asc" && cmd !== "desc") return;
  onSortOrderChange(cmd);
}

const settingsStore = useSettingsStore();
const pageSizeOptions = [100, 500, 1000] as const;
const pageSizeLabel = computed(() => String(props.pageSize));

async function onDesktopPageSizeCommand(cmd: string) {
  const n = Number(cmd);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  await settingsStore.save("galleryPageSize", n);
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
function onFilterPickerConfirm() {
  showFilterPicker.value = false;
  const v = filterPickerSelected.value[0];
  if (v === "time") {
    if (!timeMenuRoots.value.length) return;
    showTimeFilterPicker.value = true;
    return;
  }
  if (v === "plugin") {
    if (!pluginGroups.value.length) return;
    showPluginFilterPicker.value = true;
    return;
  }
  if (v === "media-type") {
    showMediaTypeFilterPicker.value = true;
    return;
  }
  if (v === "all" || v === "wallpaper-order") {
    const path = props.currentProviderPath?.trim() || "all/1";
    const next = galleryPathWithRootOnly(path, v);
    void router.push({ path: "/gallery", query: { path: next } });
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

watch(showTimeFilterPicker, (open) => {
  if (!open) return;
  const roots = timeMenuRoots.value;
  const initial = resolveInitialTimePickPath(roots, dateTail.value);
  applyTimeMenuPickerState(initial);
});

function onTimeFilterPickerChange(payload: {
  selectedValues: (string | number)[];
  columnIndex: number;
}) {
  const { columnIndex, selectedValues } = payload;
  const maxD = getTimeMenuMaxDepth(timeMenuRoots.value);
  if (columnIndex >= maxD - 1) return;
  applyTimeMenuPickerState(selectedValues.map(String));
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
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `date/${tail}`);
  void router.push({ path: "/gallery", query: { path: next } });
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
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `plugin/${id}`);
  void router.push({ path: "/gallery", query: { path: next } });
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
    const k = galleryMediaKindFromRoot(filterPathRoot.value);
    mediaTypeFilterPickerSelected.value = [k === "video" ? "video" : "image"];
  }
});
function onMediaTypeFilterPickerConfirm() {
  showMediaTypeFilterPicker.value = false;
  const kind = mediaTypeFilterPickerSelected.value[0];
  if (kind !== "image" && kind !== "video") return;
  const path = props.currentProviderPath?.trim() || "all/1";
  const next = galleryPathWithRootOnly(path, `media-type/${kind}`);
  void router.push({ path: "/gallery", query: { path: next } });
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
  await settingsStore.save("galleryPageSize", n);
}

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return t('gallery.noImages');
  }
  if (props.bigPageEnabled && props.currentPosition !== undefined) {
    return t('gallery.positionOfTotal', { pos: props.currentPosition, total: props.totalCount });
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
  "update:selectedRange": [value: [string, string] | null];
}>();

const showIds = computed(() => {
  if (IS_ANDROID) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [
    HeaderFeatureId.Refresh,
    HeaderFeatureId.Help,
    HeaderFeatureId.QuickSettings,
    HeaderFeatureId.Organize,
    HeaderFeatureId.TaskDrawer,
    HeaderFeatureId.Collect,
  ];
});

const foldIds = computed(() => {
  if (!IS_ANDROID) return [];
  const ids: HeaderFeatureId[] = [];
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
    sortOrder,
    sortOptionLabelAsc,
    sortOptionLabelDesc,
    filterFoldLabel,
    showGalleryFilterFold,
    () => props.pageSize,
  ],
  () => {
    if (!IS_ANDROID) return;
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
  if (!IS_ANDROID) return;
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
