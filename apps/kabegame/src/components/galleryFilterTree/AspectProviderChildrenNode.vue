<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByAspect')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'aspect'"
    :selectable="false"
  >
    <ProviderChildrenNode
      v-for="b in GALLERY_ASPECT_BUCKETS"
      :key="b.range"
      :name="t(`gallery.${b.labelKey}`)"
      :path="pathForSegment(`aspect/${b.range}`)"
      :depth="1"
      empty-state="disable"
      :active="isSameGalleryFilter({ type: 'aspect', range: b.range }, filter)"
      @select="$emit('select', { type: 'aspect', range: b.range })"
    />
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { GALLERY_ASPECT_BUCKETS, type GalleryFilter } from "@/utils/galleryPath";
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
</script>
