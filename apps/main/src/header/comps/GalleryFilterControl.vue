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
import { computed, onMounted, ref } from "vue";
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
  type GalleryTimeFilterPayload,
  type TimeMenuNode,
} from "@/utils/galleryTimeFilterMenu";
import GalleryTimeFilterSubmenu from "./GalleryTimeFilterSubmenu.vue";
import { usePluginStore } from "@/stores/plugins";
import { useGalleryRouteStore } from "@/stores/galleryRoute";

interface PluginGroupRow {
  plugin_id: string;
  count: number;
}

interface GalleryMediaTypeCountsPayload {
  imageCount: number;
  videoCount: number;
}

const route = useRoute();
const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const galleryRouteStore = useGalleryRouteStore();

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

const timeMenuRoots = computed<TimeMenuNode[]>(() =>
  buildGalleryTimeMenuTree(
    monthGroups.value,
    dayGroups.value,
    buildTimeMenuScopeLabels(t, String(locale.value))
  )
);

async function loadFilterCounts() {
  try {
    const [pg, timePayload, mt] = await Promise.all([
      invoke<PluginGroupRow[]>("get_gallery_plugin_groups"),
      invoke<GalleryTimeFilterPayload>("get_gallery_time_filter_data"),
      invoke<GalleryMediaTypeCountsPayload>("get_gallery_media_type_counts"),
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
}

const isOnGalleryPage = computed(() => route.path === "/gallery");

onMounted(() => void loadFilterCounts());

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
