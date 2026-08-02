<template>
  <div
    class="w-[320px] max-w-[calc(100vw-48px)] max-h-[340px] min-h-0 overflow-x-hidden overflow-y-auto p-1"
    style="--provider-tree-row-height: 32px; --provider-tree-sticky-offset: 0px"
  >
    <AnyProviderChildrenNode @select="selectFilter" />
    <DateProviderChildrenNode
      v-if="dimension === 'date'"
      @select="selectFilter"
    />
    <PluginsProviderChildrenNode
      v-else-if="dimension === 'plugin'"
      @select="selectFilter"
    />
    <MediaTypeProviderChildrenNode
      v-else-if="dimension === 'mediaType'"
      @select="selectFilter"
    />
    <AspectProviderChildrenNode
      v-else-if="dimension === 'aspect'"
      @select="selectFilter"
    />
    <SizeProviderChildrenNode
      v-else-if="dimension === 'size'"
      @select="selectFilter"
    />
    <NameProviderChildrenNode
      v-else-if="dimension === 'name'"
      @select="selectFilter"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, toRef } from "vue";
import { useDimensionFacet, type FacetDimension } from "@/composables/useAdvancedQueryFacets";
import {
  filterForDimension,
  type GalleryFilter,
  type GalleryFilterDimension,
  type GalleryFilterSet,
} from "@/utils/galleryPath";
import {
  getNode,
  type GalleryAdvancedQuery,
  type GalleryAtom,
  type NodePath,
} from "@/utils/galleryQuery";
import AnyProviderChildrenNode from "@/components/galleryFilterTree/AnyProviderChildrenNode.vue";
import AspectProviderChildrenNode from "@/components/galleryFilterTree/AspectProviderChildrenNode.vue";
import DateProviderChildrenNode from "@/components/galleryFilterTree/DateProviderChildrenNode.vue";
import MediaTypeProviderChildrenNode from "@/components/galleryFilterTree/MediaTypeProviderChildrenNode.vue";
import NameProviderChildrenNode from "@/components/galleryFilterTree/NameProviderChildrenNode.vue";
import PluginsProviderChildrenNode from "@/components/galleryFilterTree/PluginsProviderChildrenNode.vue";
import SizeProviderChildrenNode from "@/components/galleryFilterTree/SizeProviderChildrenNode.vue";
import {
  provideGalleryFilterTreeContext,
  type RefreshTarget,
} from "@/components/galleryFilterTree/context";

const props = withDefaults(defineProps<{
  tree: GalleryAdvancedQuery;
  nodePath: NodePath;
  dimension: FacetDimension;
  contextPrefix?: string;
  visible?: boolean;
}>(), {
  contextPrefix: "images://gallery/",
  visible: false,
});

const emit = defineEmits<{
  select: [filter: GalleryFilter];
}>();

const tree = toRef(props, "tree");
const nodePath = toRef(props, "nodePath");
const contextPrefix = toRef(props, "contextPrefix");
const facet = useDimensionFacet(
  tree,
  nodePath,
  props.dimension,
  contextPrefix,
);
const refreshTargets = new Set<RefreshTarget>();

const atom = computed<GalleryAtom>(() => {
  const node = getNode(props.tree, props.nodePath);
  if (!("is" in node)) {
    throw new Error("高级 facet 面板的 NodePath 必须指向原子节点");
  }
  return node.is;
});
const filters = computed<GalleryFilterSet>(() => ({
  wallpaperOrder: atom.value.wallpaperOrder,
  plugin: atom.value.plugin,
  mediaType: atom.value.mediaType,
  date: atom.value.date,
  name: atom.value.name,
  size: atom.value.size,
  aspect: atom.value.aspect,
}));
const dimension = computed<GalleryFilterDimension>(() => props.dimension);
const filter = computed(() => filterForDimension(filters.value, dimension.value));
const visible = computed(() => props.visible);

function registerRefreshTarget(target: RefreshTarget): () => void {
  refreshTargets.add(target);
  return () => {
    refreshTargets.delete(target);
  };
}

function selectFilter(nextFilter: GalleryFilter): void {
  emit("select", nextFilter);
}

provideGalleryFilterTreeContext({
  filter,
  filters,
  dimension,
  prefix: facet.reducedTreePath,
  visible,
  autoExpandRoot: computed(() => true),
  countNegated: facet.negated,
  pathForSegment: facet.pathForSegment,
  registerRefreshTarget,
});

onBeforeUnmount(() => {
  refreshTargets.clear();
});
</script>
