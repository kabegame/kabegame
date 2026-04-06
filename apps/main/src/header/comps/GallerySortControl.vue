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
          :class="{ 'is-active': galleryRouteStore.sort === 'asc' }"
        >
          {{ sortAscLabel }}
        </el-dropdown-item>
        <el-dropdown-item
          command="desc"
          :class="{ 'is-active': galleryRouteStore.sort === 'desc' }"
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
  () => galleryRouteStore.filter.type === "wallpaper-order"
);

const { t } = useI18n();

const sortAscLabel = computed(() =>
  isWallpaperOrderRoot.value
    ? t("gallery.bySetTimeAsc")
    : t("gallery.byTimeAsc")
);

const sortDescLabel = computed(() =>
  isWallpaperOrderRoot.value
    ? t("gallery.bySetTimeDesc")
    : t("gallery.byTimeDesc")
);

const sortLabel = computed(() => {
  if (isWallpaperOrderRoot.value) {
    return galleryRouteStore.sort === "desc"
      ? t("gallery.bySetTimeDesc")
      : t("gallery.bySetTimeAsc");
  }
  return galleryRouteStore.sort === "desc"
    ? t("gallery.byTimeDesc")
    : t("gallery.byTimeAsc");
});

function handleCommand(command: string) {
  const sort = command === "desc" ? "desc" : "asc";
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
