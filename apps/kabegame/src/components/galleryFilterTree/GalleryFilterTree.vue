<template>
  <div class="gallery-filter-tree">
    <div :key="treeKey" class="provider-tree">
      <!-- 单维度面板下它就是「任意」那一行（计数按去掉本维度后的过滤集算），
           所以不再按 dimension 关掉，chip 面板也不用在外面手写一个。 -->
      <AnyProviderChildrenNode @select="selectFilter" />
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
  type GalleryBrowseDimension,
  type GalleryFilterSet,
} from "@/utils/galleryPath";
import AnyProviderChildrenNode from "./AnyProviderChildrenNode.vue";
import DateProviderChildrenNode from "./DateProviderChildrenNode.vue";
import MediaTypeProviderChildrenNode from "./MediaTypeProviderChildrenNode.vue";
import SizeProviderChildrenNode from "./SizeProviderChildrenNode.vue";
import AspectProviderChildrenNode from "./AspectProviderChildrenNode.vue";
import PluginsProviderChildrenNode from "./PluginsProviderChildrenNode.vue";
import {
  provideGalleryFilterTreeContext,
  pathForTreeSegment,
  type RefreshTarget,
} from "./context";

const props = withDefaults(defineProps<{
  contextPrefix?: string;
  filter: GalleryFilter;
  filters?: GalleryFilterSet;
  dimension?: GalleryBrowseDimension | null;
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

function showDimension(value: GalleryBrowseDimension) {
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
