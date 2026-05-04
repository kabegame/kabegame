<template>
  <ProviderChildrenNode
    :name="t('gallery.filterByMediaType')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'media-type'"
    :selectable="false"
  >
    <ProviderChildrenNode
      :name="t('gallery.filterImageOnly')"
      :path="imagePath"
      :depth="1"
      :active="isSameGalleryFilter({ type: 'media-type', kind: 'image' }, filter)"
      @select="$emit('select', { type: 'media-type', kind: 'image' })"
    />
    <ProviderChildrenNode
      :name="t('gallery.filterVideoOnly')"
      :path="videoPath"
      :depth="1"
      :active="isSameGalleryFilter({ type: 'media-type', kind: 'video' }, filter)"
      @select="$emit('select', { type: 'media-type', kind: 'video' })"
    />
  </ProviderChildrenNode>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import type { GalleryFilter } from "@/utils/galleryPath";
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
const rootCountPath = computed(() => joinProviderPath(prefix.value, "all"));
const imagePath = computed(() => joinProviderPath(prefix.value, "media-type", "image"));
const videoPath = computed(() => joinProviderPath(prefix.value, "media-type", "video"));
</script>
