<template>
  <div class="gallery-toolbar">
    <div class="toolbar-left">
      <el-select :model-value="filterPluginId" @update:model-value="$emit('update:filterPluginId', $event)"
        placeholder="筛选收集源" clearable style="width: 150px">
        <el-option v-for="plugin in plugins" :key="plugin.id" :label="plugin.name" :value="plugin.id">
          <div class="plugin-option">
            <img v-if="pluginIcons[plugin.id]" :src="pluginIcons[plugin.id]" class="plugin-option-icon" />
            <el-icon v-else class="plugin-option-icon-placeholder">
              <Grid />
            </el-icon>
            <span>{{ plugin.name }}</span>
          </div>
        </el-option>
      </el-select>
      <el-button @click="$emit('refresh')" circle>
        <el-icon>
          <Refresh />
        </el-icon>
      </el-button>
    </div>
    <div class="toolbar-right">
      <el-badge v-if="activeRunningTasksCount > 0" :value="activeRunningTasksCount" :max="99" class="tasks-badge">
        <el-button @click="$emit('showTasksDrawer')" class="tasks-drawer-trigger" circle type="primary">
          <el-icon>
            <List />
          </el-icon>
        </el-button>
      </el-badge>
      <el-button v-else @click="$emit('showTasksDrawer')" class="tasks-drawer-trigger" circle type="primary">
        <el-icon>
          <List />
        </el-icon>
      </el-button>
      <el-button type="primary" @click="$emit('showCrawlerDialog')" class="add-task-btn">
        <el-icon>
          <Plus />
        </el-icon>
        开始收集
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Grid, Refresh, List, Plus } from "@element-plus/icons-vue";
import type { Plugin } from "@/stores/plugins";

interface Props {
  filterPluginId: string | null;
  plugins: Plugin[];
  pluginIcons: Record<string, string>;
  activeRunningTasksCount: number;
}

defineProps<Props>();

defineEmits<{
  "update:filterPluginId": [value: string | null];
  refresh: [];
  showTasksDrawer: [];
  showCrawlerDialog: [];
}>();
</script>

<style scoped lang="scss">
.gallery-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding: 12px 16px;
  background: var(--anime-bg-card);
  border-radius: 12px;
  box-shadow: var(--anime-shadow);

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .add-task-btn {
    box-shadow: var(--anime-shadow);

    &:hover {
      transform: translateY(-2px);
      box-shadow: var(--anime-shadow-hover);
    }
  }

  .tasks-drawer-trigger {
    box-shadow: var(--anime-shadow);
    transition: all 0.3s ease;

    &:hover {
      transform: translateY(-2px);
      box-shadow: var(--anime-shadow-hover);
    }
  }

  .tasks-badge {
    display: block;

    :deep(.el-badge__content) {
      background-color: #f56c6c !important;
      border-color: #f56c6c !important;
      color: #fff !important;
      border-radius: 50% !important;
      width: 20px !important;
      height: 20px !important;
      min-width: 20px !important;
      padding: 0 !important;
      line-height: 20px !important;
      font-size: 12px !important;
      font-weight: 500 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
  }

  .plugin-option {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .plugin-option-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }

  .plugin-option-icon-placeholder {
    width: 20px;
    height: 20px;
    color: var(--anime-text-secondary);
  }
}
</style>
