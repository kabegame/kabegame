<template>
  <PageHeader title="画廊" sticky>
    <template #subtitle>
      <span>{{ totalCountText }}</span>
    </template>
    <template #left>
      <el-button v-if="!IS_ANDROID && hasRefreshFeature" @click="$emit('refresh')" circle>
        <el-icon>
          <Refresh />
        </el-icon>
      </el-button>
      <!-- <el-date-picker class="date-range-filter" :model-value="dateRangeProxy" type="daterange" unlink-panels
        range-separator="~" start-placeholder="开始日期" end-placeholder="结束日期" format="YYYY-MM-DD"
        value-format="YYYY-MM-DD" :clearable="true" :disabled="monthLoading"
        @update:model-value="(v: [string, string] | null) => (dateRangeProxy = v)" /> -->
      <!-- 去重按钮：Android 下折叠到 overflow，非 Android 直显 -->
      <div v-if="!IS_ANDROID" class="dedupe-stack">
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
    </template>
    <!-- 非 Android：保持原有布局 -->
    <template v-if="!IS_ANDROID">
      <el-button @click="$emit('showHelp')" circle title="帮助">
        <el-icon>
          <QuestionFilled />
        </el-icon>
      </el-button>
      <el-button @click="$emit('showQuickSettings')" circle title="快捷设置">
        <el-icon>
          <Setting />
        </el-icon>
      </el-button>
      <TaskDrawerButton />
      <el-button @click="$emit('showLocalImport')" class="add-task-btn">
        <el-icon>
          <FolderOpened />
        </el-icon>
        本地导入'
      </el-button>
      <el-button type="primary" @click="handleShowCrawlerDialog" class="add-task-btn">
        <el-icon>
          <Plus />
        </el-icon>
        收集
      </el-button>
    </template>
    <!-- Android：使用 headerFeatures 驱动 -->
    <template v-else>
      <!-- 直显功能：本地导入、收集 -->
      <el-button @click="$emit('showLocalImport')" class="add-task-btn">
        <el-icon>
          <FolderOpened />
        </el-icon>
      </el-button>
      <el-button type="primary" @click="handleShowCrawlerDialog" class="add-task-btn">
        <el-icon>
          <Plus />
        </el-icon>
      </el-button>
      <!-- 任务按钮：保持直显 -->
      <TaskDrawerButton />
      <!-- 溢出菜单：去重/帮助/设置 -->
      <AndroidHeaderOverflow
        v-if="foldedFeatures.length > 0"
        :features="foldedFeatures"
        @select="handleOverflowSelect"
      />
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Refresh, Plus, Filter, Setting, Close, QuestionFilled, FolderOpened } from "@element-plus/icons-vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import TaskDrawerButton from "@/components/common/TaskDrawerButton.vue";
import AndroidHeaderOverflow from "@/components/header/AndroidHeaderOverflow.vue";
import { IS_ANDROID } from "@kabegame/core/env";
import { useCrawlerDrawerStore } from "@/stores/crawlerDrawer";
import { getFoldedFeaturesForPage, type HeaderFeatureId, hasFeatureInPage } from "@/header/headerFeatures";

interface Props {
  dedupeLoading?: boolean;
  dedupeProgress?: number;
  dedupeProcessed?: number;
  dedupeTotal?: number;
  dedupeRemoved?: number;
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  currentPosition?: number; // 当前位置（分页启用时使用）
  monthOptions?: string[];
  monthLoading?: boolean;
  selectedRange?: [string, string] | null; // YYYY-MM-DD
}

const props = withDefaults(defineProps<Props>(), {
  dedupeLoading: false,
  dedupeProgress: 0,
  dedupeProcessed: 0,
  dedupeTotal: 0,
  dedupeRemoved: 0,
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  currentPosition: 1,
  monthOptions: () => [],
  monthLoading: false,
  selectedRange: null,
});

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return "暂无图片";
  }
  // 如果启用了分页，显示当前位置
  if (props.bigPageEnabled && props.currentPosition !== undefined) {
    return `第 ${props.currentPosition} / ${props.totalCount}`;
  }
  // 否则显示原来的格式
  return `共 ${props.totalCount} 张图片`;
});

const emit = defineEmits<{
  refresh: [];
  dedupeByHash: [];
  cancelDedupe: [];
  showHelp: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  "update:selectedRange": [value: [string, string] | null];
}>();

const crawlerDrawerStore = useCrawlerDrawerStore();

const handleShowCrawlerDialog = () => {
  if (IS_ANDROID) {
    crawlerDrawerStore.open();
  } else {
    emit("showCrawlerDialog");
  }
};

const dateRangeProxy = computed<[string, string] | null>({
  get: () => props.selectedRange ?? null,
  set: (v) => emit("update:selectedRange", v ?? null),
});

const dedupeTooltipText = computed(() => {
  if (!props.dedupeLoading) return "";
  const processed = props.dedupeProcessed ?? 0;
  const total = props.dedupeTotal ?? 0;
  const removed = props.dedupeRemoved ?? 0;
  if (!total) return `已处理 ${processed}/? · 已移除 ${removed}`;
  return `已处理 ${processed}/${total} · 已移除 ${removed}`;
});

// Android 下折叠的功能
const foldedFeatures = computed(() => {
  return getFoldedFeaturesForPage("gallery");
});

// 根据 pages 列表判断刷新功能是否存在
const hasRefreshFeature = computed(() => hasFeatureInPage("gallery", "refresh"));

// 处理溢出菜单选择
const handleOverflowSelect = (featureId: HeaderFeatureId) => {
  switch (featureId) {
    case "help":
      emit("showHelp");
      break;
    case "quickSettings":
      emit("showQuickSettings");
      break;
    case "dedupe":
      emit("dedupeByHash");
      break;
  }
};
</script>

<style scoped lang="scss">
.date-range-filter {
  width: 260px;
  margin-left: 8px;
}

.add-task-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
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
</style>
