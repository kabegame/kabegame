<template>
  <div
    class="kb-tree-row group flex items-center whitespace-nowrap overflow-hidden"
    :class="{
      'kb-tree-row--active': active,
      'kb-tree-row--disabled': disabled,
      // 计数为 0:整行灰字弱化,但仍可选(排除语境下选 0 也有意义)。
      'kb-tree-row--muted': muted && !active,
      'kb-tree-row--drop': dropTarget,
    }"
    :style="{ '--tree-depth': depth }"
    :aria-busy="busy"
    :aria-disabled="disabled"
    @click="onRowClick"
    @dblclick="onRowDblclick"
    @contextmenu="$emit('row-contextmenu', $event)"
  >
    <button
      v-if="expandable"
      class="kb-tree-row__twistie"
      :class="{ 'rotate-90': expanded }"
      :disabled="disabled"
      type="button"
      data-kb-tree-twistie
      @click.stop="$emit('toggle')"
    >
      <el-icon>
        <ArrowRight />
      </el-icon>
    </button>
    <span v-else class="kb-tree-row__twistie kb-tree-row__twistie--blank" />
    <!-- 行主体：消费者全权（名称/图标/计数/装饰） -->
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ArrowRight } from "@kabegame/element-plus-icons";

const props = withDefaults(defineProps<{
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  active?: boolean;
  disabled?: boolean;
  muted?: boolean;
  busy?: boolean;
  /** DnD inside 落点高亮。 */
  dropTarget?: boolean;
}>(), {
  expandable: false,
  expanded: false,
  active: false,
  disabled: false,
  muted: false,
  busy: false,
  dropTarget: false,
});

const emit = defineEmits<{
  toggle: [];
  "row-click": [];
  "row-dblclick": [];
  "row-contextmenu": [event: MouseEvent];
}>();

function onRowClick() {
  if (props.disabled) return;
  emit("row-click");
}

function onRowDblclick() {
  if (props.disabled) return;
  emit("row-dblclick");
}
</script>

<style scoped>
/* 行观感全部走 token，缺省值 = 画廊过滤树的既有样式（宿主不设 token 即原样）。
 * 画册树等新 UI 通过在面板根上覆写这些变量对齐各自设计稿，
 * 而不是在宿主侧写 `.kb-tree-row { ... }` 覆盖。 */
.kb-tree-row {
  min-height: var(--kb-tree-row-min-height, 32px);
  padding-left: calc(var(--kb-tree-row-padding-x, 0px) + var(--tree-depth) * var(--kb-tree-indent, 16px));
  padding-right: var(--kb-tree-row-padding-x, 0px);
  border-radius: var(--kb-tree-row-radius, 6px);
  font-size: var(--kb-tree-row-font-size, inherit);
  /* 折叠三角与行主体之间的间距（画廊树历来是紧贴，缺省 0） */
  gap: var(--kb-tree-row-gap, 0);
  color: var(--anime-text-primary);
}

.kb-tree-row:hover {
  background: var(--kb-tree-row-hover-bg, rgba(255, 107, 157, 0.07));
}

.kb-tree-row--muted {
  color: var(--anime-text-muted);
}

/* active 排在 hover 之后：同特异度下后写者胜，悬停不夺走选中底色 */
.kb-tree-row--active,
.kb-tree-row--active:hover {
  background: var(--kb-tree-row-active-bg, rgba(255, 107, 157, 0.14));
  color: var(--kb-tree-row-active-color, var(--anime-primary));
  font-weight: var(--kb-tree-row-active-weight, inherit);
}

.kb-tree-row--disabled {
  opacity: 0.5;
}

.kb-tree-row--disabled:hover {
  background: transparent;
}

/* 落点高亮要压过 :hover（拖拽时指针本就悬在目标行上） */
.kb-tree-row--drop,
.kb-tree-row--drop:hover {
  outline: 1px dashed var(--anime-primary);
  outline-offset: -1px;
  background: rgba(124, 58, 237, 0.06);
}

.kb-tree-row__twistie {
  flex: none;
  width: var(--kb-tree-twistie-size, 26px);
  height: var(--kb-tree-twistie-size, 26px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  /* el-icon 的字形是 1em，用字号收口三角大小 */
  font-size: var(--kb-tree-twistie-icon-size, 1em);
  transition: transform 0.15s ease;
}

.kb-tree-row__twistie--blank {
  cursor: default;
}

.kb-tree-row--disabled .kb-tree-row__twistie {
  cursor: not-allowed;
}
</style>
