<template>
  <ProviderChildrenNode
    :name="t('gallery.filterWallpaperSet')"
    :path="path"
    :active="isSameGalleryFilter({ type: 'wallpaper-order' }, filter)"
    :filter="wallpaperChangeFilter"
    @select="$emit('select', { type: 'wallpaper-order' })"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import type { GalleryFilter } from "@/utils/galleryPath";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import {
  isSameGalleryFilter,
  joinProviderPath,
  useGalleryFilterTreeContext,
} from "./context";

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t } = useI18n();
const { filter, prefix } = useGalleryFilterTreeContext();
const path = computed(() => joinProviderPath(prefix.value, "wallpaper-order"));
const wallpaperChangeFilter = (payload: ImagesChangePayload) =>
  payload.reason === "change";
</script>
