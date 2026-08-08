<template>
  <!-- 缩进量只有 indentPx 一个来源：行的 padding-left 与 DnD 命中/插入线共用，
       避免 CSS 里写死 16px 而 DnD 按另一个值算 -->
  <div
    class="kb-tree-panel relative flex min-h-0 flex-1 flex-col"
    :style="{ '--kb-tree-indent': `${indentPx}px` }"
  >
    <!-- el-scrollbar 美化滚动条（浮层滑块不占位）；滚动元素是内部 wrap，
         scrollerRef 经 wrapRef 继续供 DnD / sticky 使用，坐标契约不变 -->
    <el-scrollbar
      ref="scrollbarRef"
      class="min-h-0 flex-1"
      wrap-class="kb-tree-panel__scroller"
      view-class="relative"
    >
      <template v-for="row in rows" :key="row.key">
        <div
          v-if="row.kind === 'separator'"
          class="flex items-center px-1.5"
          :style="{ height: `${rowHeight}px` }"
        >
          <div class="kb-tree-panel__separator h-px flex-1" />
        </div>
        <div
          v-else-if="row.kind === 'section-header'"
          class="flex items-center"
          :style="{ height: `${rowHeight}px` }"
        >
          <slot name="section-header" :section-id="row.sectionId" />
        </div>
        <KbTreeRow
          v-else
          :depth="row.node.depth"
          :expandable="row.node.hasChildren"
          :expanded="row.node.expanded"
          :active="stateOf(row.node).active"
          :disabled="stateOf(row.node).disabled"
          :muted="stateOf(row.node).muted"
          :busy="row.node.loading"
          :drop-target="isDropTarget(row.key)"
          :style="{ height: `${rowHeight}px` }"
          @toggle="onToggle(row.node)"
          @row-click="onRowClick(row.node)"
          @row-dblclick="emit('row-dblclick', row.node.element)"
          @row-contextmenu="(ev) => emit('row-contextmenu', row.node.element, ev)"
          @pointerdown="dnd.onRowPointerDown(row.key, $event)"
        >
          <slot name="row" :node="row.node" :element="row.node.element" />
        </KbTreeRow>
      </template>

      <!-- DnD 插入线（before/after 落点反馈；content 坐标随内容滚动） -->
      <div
        v-if="dragState?.accept && dragState.insertLine"
        class="pointer-events-none absolute right-1 z-[130] h-[2px] rounded bg-[var(--anime-primary)]"
        :style="{
          top: `${dragState.insertLine.top - 1}px`,
          left: `${dragState.insertLine.indent}px`,
        }"
      />
    </el-scrollbar>

    <!-- sticky 表头 overlay：顶部行的展开祖先链复制渲染（同一 #row slot，可交互） -->
    <TransitionGroup
      v-if="stickyHeaders"
      tag="div"
      name="kb-tree-sticky"
      class="pointer-events-none absolute inset-x-0 top-0 z-[120]"
    >
      <KbTreeRow
        v-for="entry in stickyEntries"
        :key="`sticky:${entry.node.key}`"
        class="kb-tree-panel__sticky-row pointer-events-auto absolute inset-x-0"
        :depth="entry.node.depth"
        :expandable="entry.node.hasChildren"
        :expanded="entry.node.expanded"
        :active="stateOf(entry.node).active"
        :disabled="stateOf(entry.node).disabled"
        :muted="stateOf(entry.node).muted"
        :busy="entry.node.loading"
        :style="{
          top: `${entry.top}px`,
          height: `${rowHeight}px`,
          transform: entry.pushOffset ? `translateY(-${entry.pushOffset}px)` : undefined,
          zIndex: 100 - entry.node.depth,
        }"
        @toggle="onToggle(entry.node)"
        @row-click="onRowClick(entry.node)"
        @row-dblclick="emit('row-dblclick', entry.node.element)"
        @row-contextmenu="(ev) => emit('row-contextmenu', entry.node.element, ev)"
      >
        <slot name="row" :node="entry.node" :element="entry.node.element" />
      </KbTreeRow>
    </TransitionGroup>

    <!-- 拖拽浮影：fixed 跟随指针的 chip -->
    <Teleport to="body">
      <div
        v-if="dragState"
        class="pointer-events-none fixed z-[4000] max-w-[240px] truncate rounded-md border border-[rgba(120,140,180,0.28)] bg-[var(--el-bg-color-overlay,#fff)] px-2.5 py-1 text-xs shadow-lg"
        :class="dragState.accept ? 'text-[var(--anime-primary)]' : 'text-[var(--anime-text-muted)]'"
        :style="{ left: `${dragState.x + 12}px`, top: `${dragState.y + 14}px` }"
      >
        {{ dragState.label }}
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts" generic="T">
import { computed, ref } from "vue";
import { ElScrollbar } from "@kabegame/element-plus";
import KbTreeRow from "./KbTreeRow.vue";
import type { TreeModel } from "./useTreeModel";
import { useTreeDnd } from "./useTreeDnd";
import { useTreeStickyHeaders } from "./useTreeStickyHeaders";
import type { TreeDndController, TreeNodeHandle, TreeRowState } from "./types";

/**
 * 树基座视图层：扁平行渲染 + sticky overlay + pointer DnD。
 * 模型由宿主创建（useTreeModel）后经 `model` prop 传入——数据获取、
 * 展开策略、过滤全在宿主侧，本组件只负责渲染与手势。
 */
const props = withDefaults(defineProps<{
  model: TreeModel<T>;
  dnd?: TreeDndController<T> | null;
  /** 等高行常量：sticky 与 DnD 命中共用；行（含分隔线/小节标题）一律此高度。 */
  rowHeight?: number;
  stickyHeaders?: boolean;
  rowState?: (element: T) => TreeRowState;
  /** 返回 true 时行点击视为展开/折叠而非选择（对应旧 selectable=false 的行为）。 */
  rowClickToggles?: (element: T) => boolean;
  /** 行名（DnD 浮影缺省文本用）。 */
  getRowLabel?: (element: T) => string;
  indentPx?: number;
}>(), {
  dnd: null,
  rowHeight: 32,
  stickyHeaders: true,
  indentPx: 16,
});

const emit = defineEmits<{
  "row-click": [element: T];
  "row-dblclick": [element: T];
  "update:expanded": [element: T, expanded: boolean];
  "row-contextmenu": [element: T, event: MouseEvent];
}>();

defineSlots<{
  row(props: { node: TreeNodeHandle<T>; element: T }): unknown;
  "section-header"(props: { sectionId: string }): unknown;
}>();

const scrollbarRef = ref<InstanceType<typeof ElScrollbar> | null>(null);
/** 真正滚动的元素是 el-scrollbar 的 wrap；DnD / sticky 的滚动几何都从它读 */
const scrollerRef = computed<HTMLElement | null>(() => scrollbarRef.value?.wrapRef ?? null);
const rows = computed(() => props.model.rows.value);

const dnd = useTreeDnd<T>({
  scroller: scrollerRef,
  rows: props.model.rows,
  rowHeight: props.rowHeight,
  indentPx: props.indentPx,
  controller: () => props.dnd,
  nodeByKey: props.model.nodeByKey,
  expand: props.model.expand,
  getDefaultLabel: (element) => props.getRowLabel?.(element) ?? "",
});
const dragState = dnd.dragState;

const stickyEntries = useTreeStickyHeaders<T>({
  scroller: scrollerRef,
  rows: props.model.rows,
  rowHeight: props.rowHeight,
  enabled: () => props.stickyHeaders,
});

const EMPTY_STATE: TreeRowState = {};
function stateOf(node: TreeNodeHandle<T>): TreeRowState {
  return props.rowState?.(node.element) ?? EMPTY_STATE;
}

function isDropTarget(key: string): boolean {
  const state = dragState.value;
  return !!state && state.accept && state.position === "inside" && state.targetKey === key;
}

function onToggle(node: TreeNodeHandle<T>) {
  const willExpand = !node.expanded;
  void props.model.toggle(node.key);
  emit("update:expanded", node.element, willExpand);
}

function onRowClick(node: TreeNodeHandle<T>) {
  // 拖拽刚结束时的合成 click 不当作选中
  if (dnd.isDragging()) return;
  if (props.rowClickToggles?.(node.element)) {
    if (node.hasChildren) onToggle(node);
    return;
  }
  emit("row-click", node.element);
}

defineExpose({ scrollerRef });
</script>

<style scoped>
/* wrap 在 el-scrollbar 内部，scoped 属性到不了，须走 :deep()。
 * 滑块是浮层不占位，原先的 scrollbar-gutter 不再需要；横向内容维持裁切。 */
:deep(.kb-tree-panel__scroller) {
  padding: var(--provider-tree-sticky-offset, 0px);
  overflow-x: hidden;
}

.kb-tree-panel__separator {
  background: var(--kb-tree-separator-color, rgba(120, 140, 180, 0.2));
}

/* 背景由宿主注入面板同款 token（与普通行观感一致，仅用于遮住底下滑过的内容）。 */
.kb-tree-panel__sticky-row {
  background: var(--kb-tree-sticky-bg, var(--el-bg-color-overlay, rgba(255, 255, 255, 0.96)));
  backdrop-filter: var(--kb-tree-sticky-backdrop, blur(8px));
}

/* sticky 行悬停不能套用普通行的半透明 hover 底——会透出底下滑过的内容。
 * 底色维持不透明的 sticky 背景，只变文字色提示可点。 */
.kb-tree-panel__sticky-row.kb-tree-row:hover {
  background: var(--kb-tree-sticky-bg, var(--el-bg-color-overlay, rgba(255, 255, 255, 0.96)));
  color: var(--kb-tree-sticky-hover-color, var(--anime-primary));
}

/* 选中的 sticky 行同理：把半透明选中底叠在不透明底之上（gradient 当纯色层用） */
.kb-tree-panel__sticky-row.kb-tree-row--active,
.kb-tree-panel__sticky-row.kb-tree-row--active:hover {
  background:
    linear-gradient(
      var(--kb-tree-row-active-bg, rgba(255, 107, 157, 0.14)),
      var(--kb-tree-row-active-bg, rgba(255, 107, 157, 0.14))
    ),
    var(--kb-tree-sticky-bg, var(--el-bg-color-overlay, rgba(255, 255, 255, 0.96)));
  color: var(--kb-tree-row-active-color, var(--anime-primary));
}

/* sticky 行淡入出现（只做 enter：离开时原生行就在同一位置，瞬时移除反而无缝） */
.kb-tree-sticky-enter-active {
  transition: opacity 0.16s ease-out;
}

.kb-tree-sticky-enter-from {
  opacity: 0;
}
</style>
