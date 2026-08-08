<template>
  <div
    class="w-[320px] max-w-[calc(100vw-48px)] max-h-[340px] min-h-0 flex flex-col overflow-hidden p-1"
    style="
      --provider-tree-row-height: 32px;
      --provider-tree-sticky-offset: 0px;
      --kb-tree-sticky-bg: var(--el-kb-filter-dropdown-panel-bg-color);
      --kb-tree-sticky-backdrop: blur(10px);
    "
  >
    <!-- 常驻不重建（无 treeKey）：草稿变化经 ctx 的 computed 流入，
         计数按 path watch 重取、active 链经 syncAutoExpand 单向展开 -->
    <GalleryFacetTreeInner :ctx="ctx" :dimensions="dimensions" @select="selectFilter" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, toRef } from "vue";
import { useDimensionFacet, type FacetDimension } from "@/composables/useAdvancedQueryFacets";
import {
  filterForDimension,
  type GalleryBrowseDimension,
  type GalleryFilter,
  type GalleryFilterSet,
} from "@/utils/galleryPath";
import {
  getNode,
  type GalleryQuery,
  type NodePath,
} from "@/utils/galleryQuery";
import GalleryFacetTreeInner from "@/components/galleryFilterTree/GalleryFacetTreeInner.vue";
import type {
  GalleryFilterTreeContext,
  RefreshTarget,
} from "@/components/galleryFilterTree/context";

const props = withDefaults(defineProps<{
  tree: GalleryQuery;
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

const atom = computed<GalleryFilterSet>(() => {
  const node = getNode(props.tree, props.nodePath);
  if (!("is" in node)) {
    throw new Error("高级 facet 面板的 NodePath 必须指向原子节点");
  }
  return node.is;
});
const filters = computed<GalleryFilterSet>(() => ({
  plugin: atom.value.plugin,
  mediaType: atom.value.mediaType,
  date: atom.value.date,
  size: atom.value.size,
  aspect: atom.value.aspect,
}));
const dimension = computed<GalleryBrowseDimension>(() => props.dimension);
const filter = computed(() => filterForDimension(filters.value, dimension.value));
const visible = computed(() => props.visible);
const dimensions = computed<GalleryBrowseDimension[]>(() => [dimension.value]);

function registerRefreshTarget(target: RefreshTarget): () => void {
  refreshTargets.add(target);
  return () => {
    refreshTargets.delete(target);
  };
}

function selectFilter(nextFilter: GalleryFilter): void {
  emit("select", nextFilter);
}

// 旧 provide/inject 注入链改为显式传参（与 GalleryFilterTree 同步迁移）
const ctx: GalleryFilterTreeContext = {
  filter,
  filters,
  dimension,
  prefix: facet.treeRootPath,
  visible,
  autoExpandRoot: computed(() => true),
  pathForSegment: facet.pathForSegment,
  listPathForSegment: facet.listPathForSegment,
  countBaseline: facet.baselineCount,
  registerRefreshTarget,
};

onBeforeUnmount(() => {
  refreshTargets.clear();
});
</script>
