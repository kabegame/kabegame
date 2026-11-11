<template>
  <div class="segmented-control" :class="{ 'is-disabled': disabled }" role="radiogroup">
    <template v-for="opt in options" :key="String(opt.value)">
      <!-- 带说明的选项用 tooltip 包一层。不可选的选项不加原生 disabled：那样悬停事件到不了它，说明就弹不出来 -->
      <el-tooltip v-if="opt.tip" :content="opt.tip" placement="top" :show-after="200">
        <button
          type="button"
          class="segmented-control-item"
          role="radio"
          :aria-checked="opt.value === modelValue"
          :aria-disabled="opt.disabled || disabled ? 'true' : undefined"
          :class="{ 'is-active': opt.value === modelValue, 'is-unavailable': opt.disabled }"
          :disabled="disabled"
          @click="onSelect(opt)"
        >
          {{ opt.label }}
        </button>
      </el-tooltip>
      <button
        v-else
        type="button"
        class="segmented-control-item"
        role="radio"
        :aria-checked="opt.value === modelValue"
        :aria-disabled="opt.disabled || disabled ? 'true' : undefined"
        :class="{ 'is-active': opt.value === modelValue, 'is-unavailable': opt.disabled }"
        :disabled="disabled"
        :title="opt.label"
        @click="onSelect(opt)"
      >
        {{ opt.label }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
type Option = {
  label: string;
  value: string;
  /** 这一项不可选：置灰、点了没反应（整组的 `disabled` 另算） */
  disabled?: boolean;
  /** 悬停说明；不可选的项用它写原因。给了就不再用选项名作原生 title */
  tip?: string;
};

const props = defineProps<{
  modelValue: string;
  options: Option[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

function onSelect(option: Option) {
  if (props.disabled || option.disabled || option.value === props.modelValue) return;
  emit("update:modelValue", option.value);
}
</script>

<style scoped>
.segmented-control {
  display: flex;
  flex-direction: row;
  /* 选项放不下时横向滚动而不是换行：换行会把控件撑成两行，
     同一栅格行里的邻居字段就被顶得参差不齐 */
  flex-wrap: nowrap;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--anime-primary) 9%, transparent);
  /* 作为 flex/grid item 时默认 min-width:auto 会撑到内容宽，overflow 永远不触发 */
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.segmented-control::-webkit-scrollbar {
  display: none;
}

.segmented-control.is-disabled {
  opacity: 0.6;
}

.segmented-control-item {
  appearance: none;
  display: flex;
  /* nowrap 下不许被压缩，否则文字会挤成竖排 */
  flex: none;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 15px;
  border: none;
  border-radius: 9px;
  margin: 0;
  color: var(--anime-text-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    box-shadow 0.2s ease;
}

.segmented-control-item:disabled {
  cursor: not-allowed;
}

/* 单个不可选的选项：比整组禁用更淡，一眼看得出是这一项选不了 */
.segmented-control-item.is-unavailable {
  opacity: 0.45;
  cursor: not-allowed;
}

.segmented-control-item:not(.is-active):not(.is-unavailable):not(:disabled):hover {
  color: var(--anime-primary);
}

.segmented-control-item.is-active {
  color: #fff;
  font-weight: 600;
  background: linear-gradient(135deg, var(--anime-primary), var(--anime-secondary));
  box-shadow: 0 3px 10px rgba(255, 107, 157, 0.3);
}
</style>
