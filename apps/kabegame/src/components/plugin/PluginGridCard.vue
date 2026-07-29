<template>
  <el-card :class="['plugin-card', cardClass]" shadow="hover">
    <span v-if="updateAvailable" class="plugin-card-update-dot" />
    <div class="plugin-card-icon">
      <el-image v-if="iconSrc" :src="iconSrc" fit="contain" />
      <el-icon v-else-if="iconLoading" class="spin">
        <Loading />
      </el-icon>
      <el-icon v-else>
        <Grid />
      </el-icon>
    </div>
    <div class="plugin-card-text">
      <div class="plugin-card-name">{{ name }}</div>
      <div class="plugin-card-version">v{{ version }}</div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { Grid, Loading } from "@element-plus/icons-vue";

defineProps<{
  name: string;
  version: string;
  iconSrc?: string | null;
  iconLoading?: boolean;
  /** 已知有更新可用时显示右上角小圆点（无法确定时不显示，不臆测） */
  updateAvailable?: boolean;
  cardClass?: string;
}>();
</script>

<style scoped lang="scss">
.plugin-card {
  position: relative;
  height: 136px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 2px solid var(--anime-border);

  &:hover {
    box-shadow: var(--anime-shadow-hover);
    border-color: var(--anime-primary-light);
  }

  :deep(.el-card__body) {
    height: 100%;
    padding: 16px 10px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
  }

  /* 紧凑端：正方形卡片，与 .plugin-grid-android 的 2 列布局配合 */
  .plugin-grid-android & {
    height: auto;
    aspect-ratio: 1;

    :deep(.el-card__body) {
      padding: 10px 6px;
    }

    .plugin-card-icon {
      width: clamp(40px, 52%, 56px);
      height: clamp(40px, 52%, 56px);
    }

    .plugin-card-name {
      font-size: 12.5px;
    }

    .plugin-card-version {
      font-size: 10px;
    }
  }
}

.plugin-card-update-dot {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-color-danger);
}

.plugin-card-icon {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: var(--anime-bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex: none;
  color: var(--anime-primary);
  font-size: 24px;

  .el-image {
    width: 38px;
    height: 38px;
  }

  .spin {
    animation: plugin-grid-card-spin 1s linear infinite;
  }
}

@keyframes plugin-grid-card-spin {
  to {
    transform: rotate(360deg);
  }
}

.plugin-card-text {
  width: 100%;
  text-align: center;
  min-width: 0;
}

.plugin-card-name {
  font: 600 13px/1.35 var(--kb-font-sans, sans-serif);
  color: var(--anime-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-card-version {
  margin-top: 3px;
  font: 400 11px/1.3 ui-monospace, Menlo, monospace;
  color: var(--anime-text-muted);
}
</style>
