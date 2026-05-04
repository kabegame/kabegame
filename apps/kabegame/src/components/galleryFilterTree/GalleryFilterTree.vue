<template>
  <div class="gallery-filter-tree">
    <div :key="contextPrefix" class="provider-tree">
      <AllProviderChildrenNode @select="selectFilter" />
      <WallpaperOrderProviderChildrenNode @select="selectFilter" />
      <DateProviderChildrenNode @select="selectFilter" />
      <MediaTypeProviderChildrenNode @select="selectFilter" />
      <PluginsProviderChildrenNode @select="selectFilter" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { GalleryFilter } from "@/utils/galleryPath";
import AllProviderChildrenNode from "./AllProviderChildrenNode.vue";
import DateProviderChildrenNode from "./DateProviderChildrenNode.vue";
import MediaTypeProviderChildrenNode from "./MediaTypeProviderChildrenNode.vue";
import PluginsProviderChildrenNode from "./PluginsProviderChildrenNode.vue";
import WallpaperOrderProviderChildrenNode from "./WallpaperOrderProviderChildrenNode.vue";
import {
  provideGalleryFilterTreeContext,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  contextPrefix?: string;
  filter: GalleryFilter;
}>(), {
  contextPrefix: "",
});

const emit = defineEmits<{
  "update:filter": [filter: GalleryFilter];
}>();

const refreshTargets = new Set<RefreshTarget>();

function registerRefreshTarget(target: RefreshTarget) {
  refreshTargets.add(target);
  return () => {
    refreshTargets.delete(target);
  };
}

async function refresh() {
  await Promise.all([...refreshTargets].map((target) => target.refresh()));
}

function selectFilter(filter: GalleryFilter) {
  emit("update:filter", filter);
}

provideGalleryFilterTreeContext({
  filter: computed(() => props.filter),
  prefix: computed(() => props.contextPrefix ?? ""),
  registerRefreshTarget,
});

defineExpose({ refresh });
</script>

<style scoped lang="scss">
.gallery-filter-tree {
  width: 320px;
  height: min(60vh, 420px);
  min-height: 0;
  background: transparent;
}

.provider-tree {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}
</style>
