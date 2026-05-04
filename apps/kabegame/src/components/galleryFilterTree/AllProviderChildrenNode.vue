<template>
  <ProviderChildrenNode
    :name="t('gallery.filterAll')"
    :path="path"
    :active="isSameGalleryFilter({ type: 'all' }, filter)"
    @select="$emit('select', { type: 'all' })"
  />
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
const path = computed(() => joinProviderPath(prefix.value, "all"));
</script>
