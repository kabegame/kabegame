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
      <!-- 自定义 slot 优先 -->
      <slot v-if="$slots.default" />
      <!-- 自动渲染 show features -->
      <template v-else>
        <template v-for="featureId in show" :key="featureId">
          <component v-if="getShowComponent(featureId)" :is="getShowComponent(featureId)"
            v-bind="getShowProps(featureId)" @action="(data: any) => $emit('action', { id: featureId, data })" />
        </template>
        <!-- fold overflow dropdown -->
        <el-dropdown v-if="fold && fold.length > 0" trigger="click" placement="bottom-end"
          @command="(id: string) => $emit('action', { id, data: { type: 'click' } })">
          <el-button circle>
            <el-icon>
              <MoreFilled />
            </el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="featureId in fold" :key="featureId" :command="featureId">
                <el-icon v-if="getFoldIcon(featureId)" style="margin-right: 8px; vertical-align: middle;">
                  <component :is="getFoldIcon(featureId)" />
                </el-icon>
                <span>{{ getFoldLabel(featureId) }}</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft, MoreFilled } from "@element-plus/icons-vue";
import { useHeaderStore } from "../../stores/header";
import HeaderActionButton from "./HeaderActionButton.vue";

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  showBack?: boolean;
  sticky?: boolean;
  show?: string[];
  fold?: string[];
}>(), {
  sticky: true,
  show: () => [],
  fold: () => [],
});

defineEmits<{
  back: [];
  action: [payload: { id: string; data: { type: string;[key: string]: any } }];
}>();

const headerStore = useHeaderStore();

const getShowComponent = (featureId: string) => {
  const feature = headerStore.get(featureId);
  if (feature?.comp) {
    return feature.comp;
  }
  if (feature?.icon && feature?.label) {
    return HeaderActionButton;
  }
  return null;
};

const getShowProps = (featureId: string) => {
  const feature = headerStore.get(featureId);
  if (feature?.comp) {
    return {};
  }
  if (feature?.icon && feature?.label) {
    return { icon: feature.icon, label: feature.label };
  }
  return {};
};

const getFoldIcon = (featureId: string) => {
  const feature = headerStore.get(featureId);
  return feature?.icon;
};

const getFoldLabel = (featureId: string) => headerStore.getFoldLabel(featureId);
</script>

<style scoped lang="scss">
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding: 16px;
  height: 64px;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
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
    gap: 8px;
    margin-left: auto;

    &>* {
      margin: 0;
    }
  }

  .right {
    display: flex;
    align-items: center;
    gap: 8px;

    &>* {
      margin: 0;
    }
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

  // fold dropdown 样式
  :deep(.el-dropdown-menu__item) {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    font-size: 14px;
    color: var(--anime-text-primary);

    &:hover {
      background-color: var(--el-fill-color-light);
    }

    .el-icon {
      font-size: 16px;
    }
  }
}
</style>
