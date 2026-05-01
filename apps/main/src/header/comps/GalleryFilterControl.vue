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
            @visible-change="onTimeMenuVisible"
          >
            <span
              class="plugin-submenu-trigger"
              :class="{ 'is-active': isTimeFilterActive }"
              @mouseenter="loadTimeRootData()"
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
                    :loading-names="timeLoadingNames"
                    :loading-text="t('common.loading')"
                    @command="handleTimeCommand"
                    @lazy-open="loadTimeNodeChildren"
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
                  <template v-for="g in pluginGroups" :key="g.plugin_id">
                    <el-dropdown-item
                      :command="pluginCommand(g.plugin_id)"
                      :class="{
                        'is-active': isPluginCommandActive(g.plugin_id),
                      }"
                    >
                      {{ pluginStore.pluginLabel(g.plugin_id) }}
                      <span class="plugin-count">({{ g.count }})</span>
                    </el-dropdown-item>
                  </template>
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
  formatTimeFilterDetail,
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
const loadedTimeKeys = ref(new Set<string>());
const timeLoadingNames = ref(new Set<string>());

const timeMenuRoots = computed<TimeMenuNode[]>(() =>
  buildGalleryTimeMenuTree(
    monthGroups.value,
    dayGroups.value,
    buildTimeMenuScopeLabels(t, String(locale.value)),
    yearGroups.value,
    { collapse: false }
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

function pluginCommand(pluginId: string, extendPath = "") {
  return extendPath ? `${pluginId}\t${extendPath}` : pluginId;
}

function parsePluginCommand(command: string) {
  const [pluginId, extendPath = ""] = String(command || "").split("\t");
  return { pluginId: pluginId.trim(), extendPath: extendPath.trim() };
}

function isPluginCommandActive(pluginId: string, extendPath = "") {
  return (
    galleryRouteStore.filter.type === "plugin" &&
    galleryRouteStore.filter.pluginId === pluginId &&
    (galleryRouteStore.filter.extendPath ?? "") === extendPath
  );
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

function replaceTimeSet(target: typeof loadedTimeKeys, op: (next: Set<string>) => void) {
  const next = new Set(target.value);
  op(next);
  target.value = next;
}

async function withTimeLoading(name: string, task: () => Promise<void>) {
  replaceTimeSet(timeLoadingNames, (next) => next.add(name));
  try {
    await task();
  } finally {
    replaceTimeSet(timeLoadingNames, (next) => next.delete(name));
  }
}

async function loadTimeRootData() {
  const prefix = filterContextPrefix.value;
  const key = `${prefix}|time-root`;
  if (loadedTimeKeys.value.has(key)) return;
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
    if (prefix !== filterContextPrefix.value) return;
    yearGroups.value = years.map((y) => ({
      year: y.year,
      count: y.total,
    }));
    replaceTimeSet(loadedTimeKeys, (next) => next.add(key));
    await ensureTimeTailLoaded(dateTail.value);
  } catch {
    monthGroups.value = [];
    dayGroups.value = [];
    yearGroups.value = [];
  }
}

async function ensureTimeYearMonthsLoaded(year: string) {
  if (!/^\d{4}$/.test(year)) return;
  const prefix = filterContextPrefix.value;
  const key = `${prefix}|time-year:${year}`;
  if (loadedTimeKeys.value.has(key)) return;
  await withTimeLoading(year, async () => {
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
      replaceTimeSet(loadedTimeKeys, (next) => next.add(key));
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
  const prefix = filterContextPrefix.value;
  const key = `${prefix}|time-month:${yearMonth}`;
  if (loadedTimeKeys.value.has(key)) return;
  await withTimeLoading(yearMonth, async () => {
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
      replaceTimeSet(loadedTimeKeys, (next) => next.add(key));
    } catch {
      if (prefix === filterContextPrefix.value) {
        dayGroups.value = dayGroups.value.filter((d) => !d.ymd.startsWith(`${yearMonth}-`));
      }
    }
  });
}

async function loadTimeNodeChildren(node: TimeMenuNode) {
  if (/^\d{4}$/.test(node.name)) {
    await ensureTimeYearMonthsLoaded(node.name);
  } else if (/^\d{4}-\d{2}$/.test(node.name)) {
    await ensureTimeMonthDaysLoaded(node.name);
  }
}

async function ensureTimeTailLoaded(tail: string | null) {
  const s = tail?.trim();
  if (!s) return;
  const year = /^(\d{4})(?:-\d{2})?(?:-\d{2})?$/.exec(s)?.[1];
  if (year) await ensureTimeYearMonthsLoaded(year);
  const yearMonth = /^(\d{4}-\d{2})(?:-\d{2})?$/.exec(s)?.[1];
  if (yearMonth) await ensureTimeMonthDaysLoaded(yearMonth);
}

function onTimeMenuVisible(open: boolean) {
  if (open) void loadTimeRootData();
}

async function loadFilterCounts() {
  loadedTimeKeys.value = new Set();
  timeLoadingNames.value = new Set();
  monthGroups.value = [];
  dayGroups.value = [];
  yearGroups.value = [];
  await Promise.all([loadPluginGroups(), loadMediaTypeCounts(), loadTimeRootData()]);
}

const isOnGalleryPage = computed(() => route.path === "/gallery");

onMounted(() => void loadFilterCounts());

watch(filterContextPrefix, () => void loadFilterCounts());

const pluginSignature = computed(() =>
  pluginStore.plugins.map((p) => `${p.id}:${p.version}`).join("|")
);

watch(pluginSignature, () => {
  pluginGroups.value = [];
  const current =
    galleryRouteStore.filter.type === "plugin" ? galleryRouteStore.filter.pluginId : "";
  if (current && !pluginStore.plugins.some((p) => p.id === current)) {
    void galleryRouteStore.navigate({ filter: { type: "all" }, page: 1 }, { push: true });
    return;
  }
  void loadPluginGroups();
});

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
    return t("gallery.filterByTimeWithDetail", {
      detail: formatTimeFilterDetail(dt, String(locale.value), t),
    });
  }
  const pid = currentPluginId.value;
  if (pid) {
    const ext =
      galleryRouteStore.filter.type === "plugin"
        ? galleryRouteStore.filter.extendPath?.trim()
        : "";
    const name = pluginStore.pluginLabel(pid);
    return ext ? `${name} / ${ext}` : t("gallery.filterByPluginWithName", { name });
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
  const { pluginId: id, extendPath } = parsePluginCommand(pluginId);
  if (!id) return;
  void galleryRouteStore.navigate(
    {
      filter: extendPath
        ? { type: "plugin", pluginId: id, extendPath }
        : { type: "plugin", pluginId: id },
      page: 1,
    },
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

.plugin-extend-item {
  padding-left: 28px !important;
  font-size: 13px;
}
</style>
