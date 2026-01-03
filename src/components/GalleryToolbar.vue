<template>
  <PageHeader title="画廊" :subtitle="totalCountText" sticky>
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
    <TaskDrawerButton />
    <el-button type="primary" @click="$emit('showCrawlerDialog')" class="add-task-btn">
      <el-icon>
        <Plus />
      </el-icon>
      收集
    </el-button>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Grid, Refresh, Plus, Star, Filter, Download, Setting } from "@element-plus/icons-vue";
import type { Plugin } from "@/stores/plugins";
import PageHeader from "@/components/common/PageHeader.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";

interface Props {
  filterPluginId: string | null;
  plugins: Plugin[];
  pluginIcons: Record<string, string>;
  showFavoritesOnly?: boolean;
  dedupeLoading?: boolean;
  hasMore?: boolean;
  isLoadingAll?: boolean;
  totalCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  showFavoritesOnly: false,
  dedupeLoading: false,
  hasMore: false,
  isLoadingAll: false,
  totalCount: 0,
});

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return "暂无图片";
  }
  return `共 ${props.totalCount} 张图片`;
});

defineEmits<{
  "update:filterPluginId": [value: string | null];
  refresh: [];
  dedupeByHash: [];
  showQuickSettings: [];
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
</style>
