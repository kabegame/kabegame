<template>
  <div class="gallery-filter-tree">
    <!-- treeKey 整树重建语义与旧实现一致：过滤/维度/前缀变化 → 模型连同计数一起重建 -->
    <GalleryFacetTreeInner
      :key="treeKey"
      class="provider-tree"
      :ctx="ctx"
      :dimensions="dimensions"
      @select="selectFilter"
    />
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
import GalleryFacetTreeInner from "./GalleryFacetTreeInner.vue";
import {
  pathForTreeSegment,
  type GalleryFilterTreeContext,
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

const ALL_DIMENSIONS: GalleryBrowseDimension[] = ["date", "mediaType", "size", "aspect", "plugin"];
const dimensions = computed(() =>
  ALL_DIMENSIONS.filter((value) => !dimension.value || dimension.value === value)
);

// 旧 provide/inject 注入链改为显式传参（特化节点删除后注入无消费者）
const ctx: GalleryFilterTreeContext = {
  filter: activeFilter,
  filters,
  dimension,
  prefix: computed(() => props.contextPrefix ?? ""),
  visible: computed(() => props.visible),
  autoExpandRoot: computed(() => dimension.value !== null),
  pathForSegment: (segment: string) =>
    pathForTreeSegment(props.contextPrefix ?? "", filters.value, dimension.value, segment),
  registerRefreshTarget,
};

defineExpose({ refresh });
</script>

<style scoped lang="scss">
.gallery-filter-tree {
  // width: ;
  --gallery-filter-tree-max-height: min(60vh, 420px);
  --provider-tree-row-height: 32px;
  --provider-tree-sticky-offset: 0px;
  /* sticky 行与下拉面板同底色（不要独立的白条观感） */
  --kb-tree-sticky-bg: var(--el-kb-filter-dropdown-panel-bg-color);
  --kb-tree-sticky-backdrop: blur(10px);
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
}
</style>
