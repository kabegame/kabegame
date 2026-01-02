<template>
  <PageHeader title="画廊" sticky>
    <template #left>
      <el-select :model-value="filterPluginId" @update:model-value="$emit('update:filterPluginId', $event)"
        placeholder="筛选源" clearable style="width: 150px" popper-class="crawl-plugin-select-dropdown">
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
      <el-button :type="showFavoritesOnly ? 'primary' : 'default'" @click="$emit('toggleFavoritesOnly')" circle>
        <el-icon>
          <Star />
        </el-icon>
      </el-button>
      <el-button @click="$emit('refresh')" circle>
        <el-icon>
          <Refresh />
        </el-icon>
      </el-button>
      <el-button @click="$emit('dedupeByHash')" :loading="dedupeLoading" :disabled="dedupeLoading">
        <el-icon>
          <Filter />
        </el-icon>
        去重
      </el-button>
      <el-button @click="$emit('loadAll')" :loading="isLoadingAll" :disabled="!hasMore || isLoadingAll">
        <el-icon>
          <Download />
        </el-icon>
        加载全部
      </el-button>
    </template>
    <el-button @click="$emit('showQuickSettings')" circle>
      <el-icon>
        <Setting />
      </el-icon>
    </el-button>
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
      收集
    </el-button>
  </PageHeader>
</template>

<script setup lang="ts">
import { Grid, Refresh, List, Plus, Star, Filter, Download, Setting } from "@element-plus/icons-vue";
import type { Plugin } from "@/stores/plugins";
import PageHeader from "@/components/common/PageHeader.vue";

interface Props {
  filterPluginId: string | null;
  plugins: Plugin[];
  pluginIcons: Record<string, string>;
  activeRunningTasksCount: number;
  showFavoritesOnly?: boolean;
  dedupeLoading?: boolean;
  hasMore?: boolean;
  isLoadingAll?: boolean;
}

withDefaults(defineProps<Props>(), {
  showFavoritesOnly: false,
  dedupeLoading: false,
  hasMore: false,
  isLoadingAll: false,
});

defineEmits<{
  "update:filterPluginId": [value: string | null];
  refresh: [];
  dedupeByHash: [];
  showQuickSettings: [];
  showTasksDrawer: [];
  showCrawlerDialog: [];
  toggleFavoritesOnly: [];
  loadAll: [];
}>();
</script>

<style scoped lang="scss">
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
</style>
