<template>
  <PageHeader title="画廊" sticky>
    <template #subtitle>
      <el-tooltip :content="totalCountTooltipText" placement="bottom" :disabled="!hasTooltip">
        <span class="subtitle-text">{{ totalCountText }}</span>
      </el-tooltip>
    </template>
    <template #left>
      <el-button @click="$emit('refresh')" circle>
        <el-icon>
          <Refresh />
        </el-icon>
      </el-button>
      <div class="dedupe-stack">
        <el-tooltip :content="dedupeTooltipText" placement="bottom" :disabled="!dedupeLoading">
          <!-- Tooltip 对 disabled button 不生效，需要包一层 -->
          <span class="dedupe-btn-wrapper">
            <el-button @click="$emit('dedupeByHash')" :loading="dedupeLoading" :disabled="dedupeLoading">
              <el-icon>
                <Filter />
              </el-icon>
              去重
            </el-button>
          </span>
        </el-tooltip>
        <div v-if="dedupeLoading" class="dedupe-progress-row">
          <div class="dedupe-progress-wrapper">
            <el-progress class="dedupe-progress" :percentage="dedupeProgress" :stroke-width="5" :show-text="false" />
          </div>
          <el-button class="dedupe-cancel-btn" circle size="small" type="danger" text @click="$emit('cancelDedupe')"
            title="取消去重">
            <el-icon>
              <Close />
            </el-icon>
          </el-button>
        </div>
      </div>
      <div class="load-all-stack">
        <el-tooltip :content="loadAllTooltipText" placement="bottom" :disabled="!isLoadingAll">
          <!-- Tooltip 对 disabled button 不生效，需要包一层 -->
          <span class="load-all-btn-wrapper">
            <el-button @click="$emit('loadAll')" :loading="isLoadingAll" :disabled="!hasMore || isLoadingAll">
              <el-icon>
                <Download />
              </el-icon>
              加载全部
            </el-button>
          </span>
        </el-tooltip>
        <div v-if="isLoadingAll" class="load-all-progress-row">
          <div class="load-all-progress-wrapper">
            <el-progress class="load-all-progress" :percentage="loadAllProgress" :stroke-width="5" :show-text="false" />
          </div>
          <el-button class="load-all-cancel-btn" circle size="small" type="danger" text @click="handleCancelLoadAll"
            title="取消加载">
            <el-icon>
              <Close />
            </el-icon>
          </el-button>
        </div>
      </div>
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
import { Refresh, Plus, Filter, Download, Setting, Close } from "@element-plus/icons-vue";
import PageHeader from "@/components/common/PageHeader.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";

interface Props {
  dedupeLoading?: boolean;
  dedupeProgress?: number;
  dedupeProcessed?: number;
  dedupeTotal?: number;
  dedupeRemoved?: number;
  hasMore?: boolean;
  isLoadingAll?: boolean;
  loadAllProgress?: number;
  loadAllLoaded?: number;
  loadAllTotal?: number;
  totalCount?: number;
  loadedCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  dedupeLoading: false,
  dedupeProgress: 0,
  dedupeProcessed: 0,
  dedupeTotal: 0,
  dedupeRemoved: 0,
  hasMore: false,
  isLoadingAll: false,
  loadAllProgress: 0,
  loadAllLoaded: 0,
  loadAllTotal: 0,
  totalCount: 0,
  loadedCount: 0,
});

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return "暂无图片";
  }
  return `共 ${props.totalCount} 张图片`;
});

const hasTooltip = computed(() => {
  return props.totalCount > 0;
});

const totalCountTooltipText = computed(() => {
  if (props.totalCount === 0) {
    return "";
  }
  const loaded = props.loadedCount ?? 0;
  const total = props.totalCount;
  return `已加载 ${loaded} 张，共 ${total} 张图片`;
});

const emit = defineEmits<{
  refresh: [];
  dedupeByHash: [];
  cancelDedupe: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
  loadAll: [];
  cancelLoadAll: [];
}>();

const loadAllTooltipText = computed(() => {
  if (!props.isLoadingAll) return "";
  const loaded = props.loadAllLoaded ?? 0;
  const total = props.loadAllTotal ?? 0;
  if (!total) return `已加载 ${loaded}/?`;
  return `已加载 ${loaded}/${total}`;
});

const dedupeTooltipText = computed(() => {
  if (!props.dedupeLoading) return "";
  const processed = props.dedupeProcessed ?? 0;
  const total = props.dedupeTotal ?? 0;
  const removed = props.dedupeRemoved ?? 0;
  if (!total) return `已处理 ${processed}/? · 已移除 ${removed}`;
  return `已处理 ${processed}/${total} · 已移除 ${removed}`;
});

const handleCancelLoadAll = () => {
  emit("cancelLoadAll");
};
</script>

<style scoped lang="scss">
.add-task-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.load-all-stack {
  display: inline-flex;
  position: relative;
  align-items: center;
}

.dedupe-stack {
  display: inline-flex;
  position: relative;
  align-items: center;
}

.dedupe-progress-row {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 0;
  z-index: 10;
}

.dedupe-btn-wrapper {
  display: inline-flex;
}

.dedupe-progress-wrapper {
  width: 72px;
}

.dedupe-progress {
  width: 100%;
  opacity: 0.9;
}

.dedupe-cancel-btn {
  padding: 0;
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  line-height: 16px;
}

.dedupe-cancel-btn :deep(.el-icon) {
  font-size: 12px;
}

.load-all-btn-wrapper {
  display: inline-flex;
}

.load-all-progress-row {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 0;
  z-index: 10;
}

.load-all-progress-wrapper {
  width: 72px;
}

.load-all-progress {
  width: 100%;
  opacity: 0.9;
}

.load-all-cancel-btn {
  padding: 0;
}

.subtitle-text {
  cursor: help;
}
</style>
