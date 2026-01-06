<template>
  <PageHeader title="画廊" :subtitle="totalCountText" sticky>
    <template #left>
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
import { Refresh, Plus, Filter, Download, Setting } from "@element-plus/icons-vue";
import PageHeader from "@/components/common/PageHeader.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";

interface Props {
  dedupeLoading?: boolean;
  hasMore?: boolean;
  isLoadingAll?: boolean;
  totalCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
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
  refresh: [];
  dedupeByHash: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
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
