<template>
  <div class="gallery-filter-tree">
    <div :key="treeKey" class="provider-tree">
      <AllProviderChildrenNode v-if="!dimension" @select="selectFilter" />
      <WallpaperOrderProviderChildrenNode v-if="showDimension('wallpaperOrder')" @select="selectFilter" />
      <NameProviderChildrenNode v-if="showDimension('name')" @select="selectFilter" />
      <DateProviderChildrenNode v-if="showDimension('date')" @select="selectFilter" />
      <MediaTypeProviderChildrenNode v-if="showDimension('mediaType')" @select="selectFilter" />
      <SizeProviderChildrenNode v-if="showDimension('size')" @select="selectFilter" />
      <AspectProviderChildrenNode v-if="showDimension('aspect')" @select="selectFilter" />
      <PluginsProviderChildrenNode v-if="showDimension('plugin')" @select="selectFilter" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  filterForDimension,
  serializeFilterSet,
  singleFilterToSet,
  type GalleryFilter,
  type GalleryFilterDimension,
  type GalleryFilterSet,
} from "@/utils/galleryPath";
import AllProviderChildrenNode from "./AllProviderChildrenNode.vue";
import NameProviderChildrenNode from "./NameProviderChildrenNode.vue";
import DateProviderChildrenNode from "./DateProviderChildrenNode.vue";
import MediaTypeProviderChildrenNode from "./MediaTypeProviderChildrenNode.vue";
import SizeProviderChildrenNode from "./SizeProviderChildrenNode.vue";
import AspectProviderChildrenNode from "./AspectProviderChildrenNode.vue";
import PluginsProviderChildrenNode from "./PluginsProviderChildrenNode.vue";
import WallpaperOrderProviderChildrenNode from "./WallpaperOrderProviderChildrenNode.vue";
import {
  provideGalleryFilterTreeContext,
  pathForTreeSegment,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  contextPrefix?: string;
  filter: GalleryFilter;
  filters?: GalleryFilterSet;
  dimension?: GalleryFilterDimension | null;
  visible?: boolean;
}>(), {
  contextPrefix: "",
  dimension: null,
  visible: true,
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

const filters = computed(() => props.filters ?? singleFilterToSet(props.filter));
const dimension = computed(() => props.dimension ?? null);
const activeFilter = computed(() =>
  dimension.value ? filterForDimension(filters.value, dimension.value) : props.filter
);
const treeKey = computed(() =>
  [props.contextPrefix ?? "", dimension.value ?? "all", serializeFilterSet(filters.value)].join("|")
);

function showDimension(value: GalleryFilterDimension) {
  return !dimension.value || dimension.value === value;
}

provideGalleryFilterTreeContext({
  filter: activeFilter,
  filters,
  dimension,
  prefix: computed(() => props.contextPrefix ?? ""),
  visible: computed(() => props.visible),
  autoExpandRoot: computed(() => dimension.value !== null),
  pathForSegment: (segment: string) =>
    pathForTreeSegment(props.contextPrefix ?? "", filters.value, dimension.value, segment),
  registerRefreshTarget,
});

defineExpose({ refresh });
</script>

<style scoped lang="scss">
.gallery-filter-tree {
  width: 320px;
  --gallery-filter-tree-max-height: min(60vh, 420px);
  --provider-tree-row-height: 32px;
  --provider-tree-sticky-offset: 0px;
  max-height: var(--gallery-filter-tree-max-height);
  min-height: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
}

.provider-tree {
  flex: 1 1 auto;
  min-height: 0;
  max-height: var(--gallery-filter-tree-max-height);
  box-sizing: border-box;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--provider-tree-sticky-offset);
  scrollbar-gutter: stable;
}
</style>
