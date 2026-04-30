<template>
  <el-dropdown v-if="showSimpleFilter" trigger="click" @command="handleCommand">
    <el-button class="gallery-filter-btn">
      <el-icon class="gallery-filter-icon">
        <Filter />
      </el-icon>
      <span class="gallery-filter-label">{{ filterLabel }}</span>
      <el-icon class="el-icon--right">
        <ArrowDown />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          command="all"
          :class="{ 'is-active': galleryRouteStore.filter.type === 'all' }"
        >
          {{ t("gallery.filterAll") }}
        </el-dropdown-item>
        <el-dropdown-item
          command="wallpaper-order"
          :class="{ 'is-active': galleryRouteStore.filter.type === 'wallpaper-order' }"
        >
          {{ t("gallery.filterWallpaperSet") }}
        </el-dropdown-item>
        <el-dropdown-item divided class="plugin-submenu-wrap" @click.stop>
          <el-dropdown
            trigger="hover"
            placement="right-start"
            @command="handleTimeCommand"
          >
            <span
              class="plugin-submenu-trigger"
              :class="{ 'is-active': isTimeFilterActive }"
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
                    @command="handleTimeCommand"
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
            @command="handlePluginCommand"
          >
            <span
              class="plugin-submenu-trigger"
              :class="{ 'is-active': isPluginFilterActive }"
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
                    :class="{
                      'is-active': currentPluginId === g.plugin_id,
                    }"
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
            @command="handleMediaTypeCommand"
          >
            <span
              class="plugin-submenu-trigger"
              :class="{ 'is-active': isMediaTypeFilterActive }"
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
                    'is-active': filterMediaKind(galleryRouteStore.filter) === 'image',
                  }"
                >
                  {{ t("gallery.filterImageOnly") }}
                  <span class="plugin-count">({{ mediaTypeCounts.imageCount }})</span>
                </el-dropdown-item>
                <el-dropdown-item
                  command="video"
                  :class="{
                    'is-active': filterMediaKind(galleryRouteStore.filter) === 'video',
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
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useImagesChangeRefresh } from "@/composables/useImagesChangeRefresh";
import { useI18n } from "@kabegame/i18n";
import { useRoute } from "vue-router";
import { ArrowDown, ArrowRight, Filter } from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import {
  filterDateSegment,
  filterMediaKind,
  filterPluginId,
  isSimpleFilter,
} from "@/utils/galleryPath";
import {
  buildGalleryTimeMenuTree,
  buildTimeMenuScopeLabels,
  type DateGroupRow,
  type DayGroupRow,
  type TimeMenuNode,
  type YearGroupRow,
} from "@/utils/galleryTimeFilterMenu";
import GalleryTimeFilterSubmenu from "./GalleryTimeFilterSubmenu.vue";
import { usePluginStore } from "@/stores/plugins";
import { useGalleryRouteStore } from "@/stores/galleryRoute";
import { storeToRefs } from "pinia";

interface PluginGroupRow {
  plugin_id: string;
  count: number;
}

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

interface ProviderChildDir {
  kind: "dir";
  name: string;
}

interface ProviderCountResult {
  total?: number | null;
}

const route = useRoute();
const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const galleryRouteStore = useGalleryRouteStore();
const { contextPath: filterContextPrefix } = storeToRefs(galleryRouteStore);

const showSimpleFilter = computed(() =>
  isSimpleFilter(galleryRouteStore.filter)
);

const currentPluginId = computed(() => filterPluginId(galleryRouteStore.filter));

const dateTail = computed(() => filterDateSegment(galleryRouteStore.filter));

const isPluginFilterActive = computed(() => currentPluginId.value != null);

const isTimeFilterActive = computed(() => dateTail.value != null);

const isMediaTypeFilterActive = computed(
  () => filterMediaKind(galleryRouteStore.filter) != null
);

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
    yearGroups.value
  )
);

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
    (e): e is ProviderChildDir =>
      !!e && e.kind === "dir" && typeof e.name === "string" && !!e.name
  );
}

async function loadPluginGroups() {
  try {
    const prefix = filterContextPrefix.value;
    const entries = await listProviderDirs(`${prefix}plugin/`);
    const groups = await Promise.all(
      entries.map(async (e) => ({
        plugin_id: e.name,
        count: await countProviderPath(`${prefix}plugin/${encodeURIComponent(e.name)}`),
      }))
    );
    pluginGroups.value = groups.filter((r) => r.count > 0);
  } catch {
    pluginGroups.value = [];
  }
}

async function loadMediaTypeCounts() {
  try {
    const prefix = filterContextPrefix.value;
    const [imageCount, videoCount] = await Promise.all([
      countProviderPath(`${prefix}media-type/image`),
      countProviderPath(`${prefix}media-type/video`),
    ]);
    mediaTypeCounts.value = { imageCount, videoCount };
  } catch {
    mediaTypeCounts.value = { imageCount: 0, videoCount: 0 };
  }
}

const YEAR_SEG_RE = /^(\d{4})y$/;
const MONTH_SEG_RE = /^(\d{2})m$/;
const DAY_SEG_RE = /^(\d{2})d$/;

async function loadTimeFilterData() {
  const prefix = filterContextPrefix.value;
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
          ...y,
          total: await countProviderPath(`${prefix}date/${y.seg}`),
        }))
      )
    ).filter((y) => y.total > 0);
    yearGroups.value = years.map((y) => ({
      year: y.year,
      count: y.total,
    }));

    const monthsPerYear = await Promise.all(
      years.map(async (y) => {
        try {
          const monthEntries = await listProviderDirs(`${prefix}date/${y.seg}/`);
          const monthCandidates = monthEntries
            .map((e) => {
              const m = MONTH_SEG_RE.exec(e.name);
              return m
                ? { year: y.year, month: m[1]!, yearSeg: y.seg, seg: e.name }
                : null;
            })
            .filter(
              (x): x is { year: string; month: string; yearSeg: string; seg: string } => !!x
            );
          return (
            await Promise.all(
              monthCandidates.map(async (mo) => ({
                ...mo,
                total: await countProviderPath(`${prefix}date/${mo.yearSeg}/${mo.seg}`),
              }))
            )
          ).filter((x) => x.total > 0);
        } catch {
          return [];
        }
      })
    );
    const months = monthsPerYear.flat();

    const daysPerMonth = await Promise.all(
      months.map(async (mo) => {
        try {
          const dayEntries = await listProviderDirs(`${prefix}date/${mo.yearSeg}/${mo.seg}/`);
          const dayCandidates = dayEntries
            .map((e) => {
              const m = DAY_SEG_RE.exec(e.name);
              return m
                ? {
                    year: mo.year,
                    month: mo.month,
                    yearSeg: mo.yearSeg,
                    monthSeg: mo.seg,
                    day: m[1]!,
                    seg: e.name,
                  }
                : null;
            })
            .filter(
              (x): x is {
                year: string;
                month: string;
                yearSeg: string;
                monthSeg: string;
                day: string;
                seg: string;
              } => !!x
            );
          return (
            await Promise.all(
              dayCandidates.map(async (d) => ({
                ...d,
                total: await countProviderPath(`${prefix}date/${d.yearSeg}/${d.monthSeg}/${d.seg}`),
              }))
            )
          ).filter((x) => x.total > 0);
        } catch {
          return [];
        }
      })
    );

    monthGroups.value = months.map((mo) => ({
      year_month: `${mo.year}-${mo.month}`,
      count: mo.total,
    }));
    dayGroups.value = daysPerMonth.flat().map((d) => ({
      ymd: `${d.year}-${d.month}-${d.day}`,
      count: d.total,
    }));
  } catch {
    monthGroups.value = [];
    dayGroups.value = [];
    yearGroups.value = [];
  }
}

async function loadFilterCounts() {
  await Promise.all([loadPluginGroups(), loadMediaTypeCounts(), loadTimeFilterData()]);
}

const isOnGalleryPage = computed(() => route.path === "/gallery");

onMounted(() => void loadFilterCounts());

watch(filterContextPrefix, () => void loadFilterCounts());

useImagesChangeRefresh({
  enabled: isOnGalleryPage,
  waitMs: 500,
  onRefresh: () => void loadFilterCounts(),
});

const filterLabel = computed(() => {
  void locale.value;
  if (galleryRouteStore.filter.type === "wallpaper-order") {
    return t("gallery.filterWallpaperSet");
  }
  if (galleryRouteStore.filter.type === "date-range") {
    const f = galleryRouteStore.filter;
    return `${f.start} ~ ${f.end}`;
  }
  const dt = dateTail.value;
  if (dt) {
    return t("gallery.filterByTimeWithDetail", { detail: dt });
  }
  const pid = currentPluginId.value;
  if (pid) {
    return t("gallery.filterByPluginWithName", { name: pluginStore.pluginLabel(pid) });
  }
  const mk = filterMediaKind(galleryRouteStore.filter);
  if (mk === "image") {
    return `${t("gallery.filterImageOnlyLabel")} (${mediaTypeCounts.value.imageCount})`;
  }
  if (mk === "video") {
    return `${t("gallery.filterVideoOnlyLabel")} (${mediaTypeCounts.value.videoCount})`;
  }
  return t("gallery.filterAll");
});

function handleCommand(command: string) {
  if (command !== "all" && command !== "wallpaper-order") return;
  void galleryRouteStore.navigate(
    {
      filter:
        command === "all"
          ? { type: "all" }
          : { type: "wallpaper-order" },
      page: 1,
    },
    { push: true }
  );
}

function handlePluginCommand(pluginId: string) {
  const id = (pluginId || "").trim();
  if (!id) return;
  void galleryRouteStore.navigate(
    { filter: { type: "plugin", pluginId: id }, page: 1 },
    { push: true }
  );
}

function handleTimeCommand(name: string) {
  const seg = (name || "").trim();
  if (!seg) return;
  void galleryRouteStore.navigate(
    { filter: { type: "date", segment: seg }, page: 1 },
    { push: true }
  );
}

function handleMediaTypeCommand(kind: string) {
  if (kind !== "image" && kind !== "video") return;
  void galleryRouteStore.navigate(
    { filter: { type: "media-type", kind }, page: 1 },
    { push: true }
  );
}
</script>

<style scoped lang="scss">
.gallery-filter-btn {
  .gallery-filter-icon {
    margin-right: 6px;
    font-size: 14px;
  }
  .gallery-filter-label {
    margin-right: 4px;
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
  outline: none;
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
