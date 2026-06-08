<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByName')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'name'"
    :selectable="false"
    :filter="nameChangeFilter"
  >
    <ProviderChildrenNode
      v-for="b in GALLERY_NAME_LANGUAGE_BUCKETS"
      :key="b.bucket"
      :name="b.autonym"
      :path="pathForSegment(`name/${b.bucket}`)"
      :depth="1"
      empty-state="disable"
      :active="isSameGalleryFilter({ type: 'name', bucket: b.bucket }, filter)"
      :filter="nameChangeFilter"
      @select="$emit('select', { type: 'name', bucket: b.bucket })"
    />
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { GALLERY_NAME_LANGUAGE_BUCKETS, type GalleryFilter } from "@/utils/galleryPath";
import type { ImagesChangePayload } from "@/composables/useImagesChangeRefresh";
import ProviderChildrenNode from "./ProviderChildrenNode.vue";
import {
  isSameGalleryFilter,
  useGalleryFilterTreeContext,
} from "./context";

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t } = useI18n();
const { filter, pathForSegment } = useGalleryFilterTreeContext();
const rootCountPath = computed(() => pathForSegment("all"));
const nameChangeFilter = (payload: ImagesChangePayload) =>
  payload.reason === "add" || payload.reason === "delete" || payload.reason === "rename";
</script>
