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
        <span class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {{ source.descriptor(element).name }}
        </span>
        <span
          v-if="counts.hasCountOf(keyOf(element))"
          class="flex-none text-[var(--anime-text-secondary)] text-xs"
          :class="{
            '!text-[var(--el-color-error)]': counts.deltaSignOf(keyOf(element)) < 0,
            '!text-[var(--el-color-success)]': counts.deltaSignOf(keyOf(element)) > 0,
            '!text-[var(--anime-text-muted)]': counts.isEmptyOf(keyOf(element)),
          }"
        >
          ({{ counts.displayOf(keyOf(element)) }})
        </span>
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
import type { TreeRowState } from "@/components/tree/types";
import type { GalleryFilterTreeContext } from "./context";
import { createGalleryFacetSource, type FacetNode } from "./facetTreeSource";
import { useFacetNodeCounts } from "./useFacetNodeCounts";

/**
 * 画廊过滤树内核：模型 + 计数适配层 + pathql 观察 + KbTreePanel 装配。
 * GalleryFilterTree（侧栏 chip 面板，:key 整树重建）与 AdvancedFacetTreePanel
 * （高级弹窗 facet，常驻不重建）共用。ctx / dimension 视为 mount 期常量。
 * 没有维度根：顶层直接是该维度的子项，侧栏根列表就是一次 `_kb_co` 列举，高级候选使用纯净路径。
 */
const props = defineProps<{
  ctx: GalleryFilterTreeContext;
  dimension: GalleryBrowseDimension;
}>();

const emit = defineEmits<{
  select: [filter: GalleryFilter];
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const source = createGalleryFacetSource(props.ctx, { t, locale, pluginStore });
const keyOf = source.dataSource.getKey;
const isDeltaMode = !!props.ctx.countBaseline;

const model = useTreeModel<FacetNode>({
  dataSource: source.dataSource,
  sections: () => [{ id: props.dimension }],
  // 高级面板常驻观察候选；侧栏隐藏时停观察、显示时补读。
  active: () => isDeltaMode || props.ctx.visible.value,
  // active 祖先链展开（选中某日时其年、月展开）
  defaultExpanded: (element) => source.descriptor(element).defaultExpanded,
});

const counts = useFacetNodeCounts({ ctx: props.ctx, model, source });

const pluginSignature = () => pluginStore.plugins.map((plugin) => `${plugin.id}:${plugin.version}`).join("|");
watch(pluginSignature, () => {
  if (props.dimension === "plugin") void model.refresh();
});

const unregisterBranchTarget = props.ctx.registerRefreshTarget({
  refresh: async () => {
    await model.refresh();
    if (isDeltaMode) await counts.refreshAll();
  },
});
onBeforeUnmount(unregisterBranchTarget);

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
  const descriptor = source.descriptor(element);
  return {
    active: descriptor.active,
    clickable: descriptor.selectable,
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
