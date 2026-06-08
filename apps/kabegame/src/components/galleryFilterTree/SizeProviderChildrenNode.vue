<template>
  <ProviderChildrenNode
    :name="t('gallery.filterBySize')"
    :path="rootCountPath"
    :default-expanded="filter.type === 'size'"
    :selectable="false"
  >
    <ProviderChildrenNode
      v-for="b in BUCKETS"
      :key="b.range"
      :name="t(`gallery.${b.labelKey}`)"
      :path="pathForSegment(`size/${b.range}`)"
      :depth="1"
      empty-state="disable"
      :active="isSameGalleryFilter({ type: 'size', range: b.range }, filter)"
      @select="$emit('select', { type: 'size', range: b.range })"
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
  useGalleryFilterTreeContext,
} from "./context";

const BUCKETS: Array<{ range: string; labelKey: string }> = [
  { range: "unknown",    labelKey: "filterSize_unknown" },
  { range: "1B-512KB",   labelKey: "filterSize_lt512k" },
  { range: "512KB-1MB",  labelKey: "filterSize_512k_1m" },
  { range: "1MB-2MB",    labelKey: "filterSize_1m_2m" },
  { range: "2MB-5MB",    labelKey: "filterSize_2m_5m" },
  { range: "5MB-10MB",   labelKey: "filterSize_5m_10m" },
  { range: "10MB-50MB",  labelKey: "filterSize_10m_50m" },
  { range: "50MB-",      labelKey: "filterSize_gte50m" },
];

defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t } = useI18n();
const { filter, pathForSegment } = useGalleryFilterTreeContext();
const rootCountPath = computed(() => pathForSegment("all"));
</script>
