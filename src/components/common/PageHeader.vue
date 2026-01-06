<template>
  <div class="page-header" :class="{ 'sticky': props.sticky }">
    <div class="left">
      <el-button v-if="showBack" circle @click="$emit('back')">
        <el-icon>
          <ArrowLeft />
        </el-icon>
      </el-button>
      <div v-if="$slots.icon" class="icon-slot">
        <slot name="icon" />
      </div>
      <div class="text">
        <div class="title" :class="{ 'has-slot': $slots.title }">
          <slot name="title">
            <span class="title-text">{{ title }}</span>
          </slot>
        </div>
        <div class="subtitle" v-if="subtitle || $slots.subtitle">
          <slot name="subtitle">
            {{ subtitle }}
          </slot>
        </div>
      </div>
      <div v-if="$slots.left" class="left-slot">
        <slot name="left" />
      </div>
    </div>
    <div class="right">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from "@element-plus/icons-vue";

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  showBack?: boolean;
  sticky?: boolean;
}>(), {
  sticky: true,
});

defineEmits<{
  back: [];
}>();
</script>

<style scoped lang="scss">
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding: 16px;
  min-height: 64px;
  background: var(--anime-bg-card);
  border-radius: 12px;
  box-shadow: var(--anime-shadow);

  &.sticky {
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 0;
  }

  .left-slot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .title {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    
    // 默认渐变文字效果（仅应用于默认的 title-text）
    .title-text {
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    
    // 当使用插槽时，重置样式，让插槽内容自己控制
    &.has-slot {
      background: none;
      -webkit-background-clip: unset;
      -webkit-text-fill-color: unset;
      background-clip: unset;
    }
  }

  .subtitle {
    color: var(--anime-text-muted);
    font-size: 13px;
    line-height: 1.2;
  }

  .icon-slot {
    width: 64px;
    height: 64px;
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--anime-bg-secondary);
    border: 2px solid var(--anime-border);
  }
}
</style>
