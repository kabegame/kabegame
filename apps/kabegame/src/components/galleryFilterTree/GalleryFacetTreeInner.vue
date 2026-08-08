<template>
  <KbTreePanel
    :model="model"
    :row-state="rowState"
    :row-click-toggles="rowClickToggles"
    :get-row-label="(el: FacetNode) => source.descriptor(el).name"
    @row-click="onRowClick"
  >
    <template #row="{ element }">
      <!-- 与旧 ProviderChildrenNode 行主体逐 class 相同：
           名称 + 内联 ({{count}})；本次不做右对齐 -->
      <button
        class="min-w-0 flex-1 h-[30px] flex items-center gap-1 border-0 bg-transparent text-inherit text-left cursor-pointer"
        :class="{ 'cursor-default': !source.descriptor(element).selectable }"
        type="button"
        tabindex="-1"
      >
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{{
          source.descriptor(element).name
        }}</span>
        <span
          class="flex-none text-[var(--anime-text-secondary)] text-xs"
          :class="{
            '!text-[var(--el-color-error)]': counts.deltaSignOf(keyOf(element)) < 0,
            '!text-[var(--el-color-success)]': counts.deltaSignOf(keyOf(element)) > 0,
            '!text-[var(--anime-text-muted)]': counts.isEmptyOf(keyOf(element)),
          }"
        >({{ counts.displayOf(keyOf(element)) }})</span>
      </button>
    </template>
  </KbTreePanel>
</template>

<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { serializeFilterSet, type GalleryBrowseDimension, type GalleryFilter } from "@/utils/galleryPath";
import KbTreePanel from "@/components/tree/KbTreePanel.vue";
import { useTreeModel } from "@/components/tree/useTreeModel";
import { useTreeRefreshHub } from "@/components/tree/useTreeRefreshHub";
import type { TreeRowState } from "@/components/tree/types";
import type { GalleryFilterTreeContext } from "./context";
import { createGalleryFacetSource, type FacetNode } from "./facetTreeSource";
import { useFacetNodeCounts } from "./useFacetNodeCounts";
import { defaultGalleryTreeRefreshSources, pluginListRefreshSources } from "./refreshSources";

/**
 * 画廊过滤树内核：模型 + 计数适配层 + 刷新枢纽 + KbTreePanel 装配。
 * GalleryFilterTree（侧栏 chip 面板，:key 整树重建）与 AdvancedFacetTreePanel
 * （高级弹窗 facet，常驻不重建）共用。ctx / dimensions 视为 mount 期常量。
 */
const props = defineProps<{
  ctx: GalleryFilterTreeContext;
  dimensions: GalleryBrowseDimension[];
}>();

const emit = defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const source = createGalleryFacetSource(props.ctx, { t, locale, pluginStore });
const keyOf = source.dataSource.getKey;

const hub = useTreeRefreshHub({
  sources: [
    ...defaultGalleryTreeRefreshSources(),
    // plugin-* 事件只在存在插件维度时监听（旧 PluginsProviderChildrenNode 的裸监听）
    ...(props.dimensions.includes("plugin") ? pluginListRefreshSources() : []),
  ],
});

const rootNodes = source.roots(props.dimensions);

const model = useTreeModel<FacetNode>({
  dataSource: source.dataSource,
  sections: () => [{ id: "facets", roots: () => rootNodes }],
  // 旧 shouldAutoExpand：defaultExpanded ||（autoExpandRoot && 根 && 有子）
  defaultExpanded: (element, depth) =>
    source.descriptor(element).defaultExpanded ||
    (props.ctx.autoExpandRoot.value && depth === 0 && source.dataSource.hasChildren(element)),
  // 分支首次加载完成 → 注册事件驱动的子项重枚举（旧 enabled: loaded 的枚举订阅；
  // 子树被 key-diff 释放后 refreshChildren 自然空转，无需显式退订）
  onChildrenLoaded: (handle) => {
    hub.register({
      waitMs: 3000,
      filter: source.childrenRefreshFilter(handle.element),
      onRefresh: () => model.refreshChildren(handle.key),
    });
  },
});

const counts = useFacetNodeCounts({ ctx: props.ctx, hub, model, source });

// 整树集中刷新（GalleryFilterTree.refresh() / refreshProviderFilterTree 入口）：
// 计数目标由 useFacetNodeCounts 逐节点注册；分支重枚举在此补一条。
const unregisterBranchTarget = props.ctx.registerRefreshTarget({
  refresh: () => model.refreshLoadedChildren(),
});
onBeforeUnmount(() => unregisterBranchTarget());

/**
 * 旧 syncAutoExpand 等价物：面板可见期间，active 祖先链的 defaultExpanded
 * 翻真时单向自动展开（高级面板常驻不重建，靠这个跟上草稿变化）。
 */
function syncAutoExpand() {
  if (!props.ctx.visible.value) return;
  for (const handle of model.allNodes()) {
    if (!handle.expanded && handle.hasChildren && source.descriptor(handle.element).defaultExpanded) {
      void model.expand(handle.key);
    }
  }
}
watch(
  () => [props.ctx.visible.value, serializeFilterSet(props.ctx.filters.value)] as const,
  () => syncAutoExpand(),
);

function rowState(element: FacetNode): TreeRowState {
  return {
    active: source.descriptor(element).active,
    muted: counts.isEmptyOf(keyOf(element)),
  };
}

function rowClickToggles(element: FacetNode): boolean {
  return !source.descriptor(element).selectable;
}

function onRowClick(element: FacetNode) {
  const descriptor = source.descriptor(element);
  if (descriptor.selectable && descriptor.filterOnSelect) {
    emit("select", descriptor.filterOnSelect);
  }
}
</script>
