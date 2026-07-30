<template>
  <div class="kb-tab" role="tablist">
    <button
      v-for="item in items"
      :key="item.name"
      type="button"
      role="tab"
      class="kb-tab-item"
      :class="{ 'is-active': item.name === model, 'kb-tab-item--icon-only': item.iconOnly }"
      :aria-selected="item.name === model"
      :title="item.iconOnly ? item.label : undefined"
      @click="select(item)"
    >
      <el-icon v-if="item.icon" class="kb-tab-icon">
        <component :is="item.icon" />
      </el-icon>
      <span v-if="!item.iconOnly" class="kb-tab-label">{{ item.label }}</span>
      <span v-if="item.count != null" class="kb-tab-count">{{ item.count }}</span>
      <el-icon
        v-if="item.closable"
        class="kb-tab-close"
        :title="closeTitle"
        @click.stop="emit('close', item.name)"
      >
        <Close />
      </el-icon>
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
import type { Component } from "vue";
import { ElIcon } from "element-plus";
import { Close } from "@element-plus/icons-vue";

export interface KbTabItem<T extends string = string> {
  /** 唯一标识，也是 v-model 的值 */
  name: T;
  label: string;
  /** 右上角计数；null/undefined 表示不显示（区别于「数量为 0」） */
  count?: number | null;
  icon?: Component;
  /** 只渲染图标（如末尾的「添加」按钮） */
  iconOnly?: boolean;
  /** 显示删除叉号，点击 emit('close', name) 而不切换选中 */
  closable?: boolean;
  /**
   * 点击时不切换选中，只 emit('select', name)。
   * 用于「添加源」这类点了要开弹窗、本身不是一个内容页的项。
   */
  action?: boolean;
}

const model = defineModel<T>({ required: true });

defineProps<{
  items: KbTabItem<T>[];
  closeTitle?: string;
}>();

const emit = defineEmits<{
  (e: "close", name: T): void;
  (e: "select", name: T): void;
}>();

function select(item: KbTabItem<T>) {
  emit("select", item.name);
  if (item.action) return;
  model.value = item.name;
}
</script>

<style scoped lang="scss">
/* 分段式胶囊组。配色沿用设置弹窗左导航（Settings.vue 的 .settings-category-button）：
   hover 是主色 8% 的浅底，选中是 primary→secondary 渐变 + 白字。 */
.kb-tab {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 14px;
  background: var(--anime-bg-sidebar);
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.kb-tab-item {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  margin: 0;
  border: none;
  border-radius: 12px;
  font: inherit;
  font-size: 14px;
  color: var(--anime-text-primary);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;

  &:hover {
    background: color-mix(in srgb, var(--anime-primary) 8%, transparent);
  }

  &.is-active {
    color: #fff;
    font-weight: 600;
    background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
    box-shadow: var(--anime-shadow);
  }
}

.kb-tab-item--icon-only {
  padding: 0 10px;
  gap: 0;
}

.kb-tab-icon {
  flex: none;
  font-size: 15px;
}

/* 计数与叉号都跟随 tab 自身文字色（选中态是白字渐变底），只压低透明度做主次区分 */
.kb-tab-count {
  font: 600 11.5px/1 ui-monospace, Menlo, monospace;
  color: inherit;
  opacity: 0.6;
}

.kb-tab-close {
  font-size: 13px;
  color: inherit;
  opacity: 0.55;
  transition: opacity 0.2s ease, color 0.2s ease;

  &:hover {
    opacity: 1;
    color: var(--el-color-danger);
  }
}
</style>
