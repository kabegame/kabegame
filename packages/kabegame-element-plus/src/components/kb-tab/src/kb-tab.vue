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
import { ElIcon } from "@kabegame/element-plus/components/icon";
import { Close } from "@kabegame/element-plus-icons";
import type { KbTabItem } from "./kb-tab";

// withInstall 靠 comp.name 做全局注册，<script setup> 不写就会注册成 undefined
defineOptions({ name: "KbTab" });

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
  flex-wrap: nowrap;
  gap: 2px;
  padding: 3px;
  border-radius: 14px;
  background: var(--anime-bg-sidebar);
  max-width: 100%;
  /* 作为 flex item 时默认 min-width:auto 会撑到内容宽，overflow 永远不触发；
     置 0 才能收缩并让下面的 overflow-x 真正滚动起来 */
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
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
