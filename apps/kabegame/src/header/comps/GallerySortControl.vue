<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <el-button class="gallery-sort-btn">
      <el-icon class="gallery-sort-icon">
        <Sort />
      </el-icon>
      <span class="gallery-sort-label">{{ sortLabel }}</span>
      <el-icon class="el-icon--right">
        <ArrowDown />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          command="asc"
          :class="{ 'is-active': !galleryRouteStore.sort.desc }"
        >
          {{ sortAscLabel }}
        </el-dropdown-item>
        <el-dropdown-item
          command="desc"
          :class="{ 'is-active': galleryRouteStore.sort.desc }"
        >
          {{ sortDescLabel }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useRoute } from "vue-router";
import { ArrowDown, Sort } from "@element-plus/icons-vue";
import { useGalleryRouteStore } from "@/stores/galleryRoute";

const route = useRoute();
const galleryRouteStore = useGalleryRouteStore();

const isWallpaperOrderRoot = computed(
  () => !!galleryRouteStore.filters.wallpaperOrder
);

const isSizeRoot = computed(() => !!galleryRouteStore.filters.size);
const isAspectRoot = computed(() => !!galleryRouteStore.filters.aspect);

const { t } = useI18n();

const sortAscLabel = computed(() => {
  if (galleryRouteStore.sort.field === "by-id") return t("gallery.byDefaultAsc");
  if (galleryRouteStore.sort.field === "by-time") return t("gallery.byTimeAsc");
  if (galleryRouteStore.sort.field === "by-name") return t("gallery.byNameAsc");
  if (galleryRouteStore.sort.field === "by-size") return t("gallery.bySizeAsc");
  if (galleryRouteStore.sort.field === "by-aspect") return t("gallery.byAspectWidthHeight");
  if (galleryRouteStore.sort.field === "by-set-time") return t("gallery.bySetTimeAsc");
  if (isWallpaperOrderRoot.value) return t("gallery.bySetTimeAsc");
  if (isSizeRoot.value) return t("gallery.bySizeAsc");
  if (isAspectRoot.value) return t("gallery.byAspectWidthHeight");
  return t("gallery.byTimeAsc");
});

const sortDescLabel = computed(() => {
  if (galleryRouteStore.sort.field === "by-id") return t("gallery.byDefaultDesc");
  if (galleryRouteStore.sort.field === "by-time") return t("gallery.byTimeDesc");
  if (galleryRouteStore.sort.field === "by-name") return t("gallery.byNameDesc");
  if (galleryRouteStore.sort.field === "by-size") return t("gallery.bySizeDesc");
  if (galleryRouteStore.sort.field === "by-aspect") return t("gallery.byAspectHeightWidth");
  if (galleryRouteStore.sort.field === "by-set-time") return t("gallery.bySetTimeDesc");
  if (isWallpaperOrderRoot.value) return t("gallery.bySetTimeDesc");
  if (isSizeRoot.value) return t("gallery.bySizeDesc");
  if (isAspectRoot.value) return t("gallery.byAspectHeightWidth");
  return t("gallery.byTimeDesc");
});

const sortLabel = computed(() => {
  if (galleryRouteStore.sort.desc) return sortDescLabel.value;
  return sortAscLabel.value;
});

function handleCommand(command: string) {
  const sort = { ...galleryRouteStore.sort, desc: command === "desc" };
  void galleryRouteStore.navigate({ sort }, { push: route.path !== "/gallery" });
}
</script>

<style scoped lang="scss">
.gallery-sort-btn {
  .gallery-sort-icon {
    margin-right: 6px;
    font-size: 14px;
  }
  .gallery-sort-label {
    margin-right: 4px;
  }
}
</style>
