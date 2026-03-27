<template>
  <!-- 紧凑单行：自动配置卡片侧栏等 -->
  <div v-if="layout === 'inline'" class="task-summary-row task-summary-row--inline">
    <div class="task-summary-inline-grow">
      <el-tooltip v-if="tooltipContent" placement="top" :show-after="400">
        <template #content>
          <div class="task-summary-tooltip">{{ tooltipContent }}</div>
        </template>
        <div class="task-inline-inner">
          <span class="task-inline-name">{{ pluginDisplayName }}</span>
          <div class="task-inline-stats" @click.stop>
            <span
              class="task-inline-stat count-success"
              :class="{ 'is-zero': successN === 0 }"
              :title="t('tasks.totalCount', { n: successN })"
            >{{ successN }}</span>
            <span class="task-inline-sep" aria-hidden="true">/</span>
            <span
              class="task-inline-stat count-failed"
              :class="{ 'is-zero': failedN === 0 }"
              :title="t('tasks.failedCount', { n: failedN })"
            >{{ failedN }}</span>
            <span class="task-inline-sep" aria-hidden="true">/</span>
            <span
              class="task-inline-stat count-deleted"
              :class="{ 'is-zero': deletedN === 0 }"
              :title="t('tasks.deletedCount', { n: deletedN })"
            >{{ deletedN }}</span>
            <span class="task-inline-sep" aria-hidden="true">/</span>
            <span
              class="task-inline-stat count-dedup"
              :class="{ 'is-zero': dedupN === 0 }"
              :title="t('tasks.dedupCount', { n: dedupN })"
            >{{ dedupN }}</span>
          </div>
        </div>
      </el-tooltip>
      <div v-else class="task-inline-inner">
        <span class="task-inline-name">{{ pluginDisplayName }}</span>
        <div class="task-inline-stats">
          <span
            class="task-inline-stat count-success"
            :class="{ 'is-zero': successN === 0 }"
            :title="t('tasks.totalCount', { n: successN })"
          >{{ successN }}</span>
          <span class="task-inline-sep" aria-hidden="true">/</span>
          <span
            class="task-inline-stat count-failed"
            :class="{ 'is-zero': failedN === 0 }"
            :title="t('tasks.failedCount', { n: failedN })"
          >{{ failedN }}</span>
          <span class="task-inline-sep" aria-hidden="true">/</span>
          <span
            class="task-inline-stat count-deleted"
            :class="{ 'is-zero': deletedN === 0 }"
            :title="t('tasks.deletedCount', { n: deletedN })"
          >{{ deletedN }}</span>
          <span class="task-inline-sep" aria-hidden="true">/</span>
          <span
            class="task-inline-stat count-dedup"
            :class="{ 'is-zero': dedupN === 0 }"
            :title="t('tasks.dedupCount', { n: dedupN })"
          >{{ dedupN }}</span>
        </div>
      </div>
    </div>
    <div class="task-summary-actions">
      <el-button
        v-if="showRunParamsButton"
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.openRunParams')"
        @click.stop="emit('open-run-params')"
      >
        <el-icon><InfoFilled /></el-icon>
      </el-button>
      <el-button
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.drawerViewImages')"
        @click.stop="emit('open-task-images', task.id)"
      >
        <el-icon><Picture /></el-icon>
      </el-button>
      <el-button
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.drawerViewLog')"
        @click.stop="emit('open-task-log', task.id)"
      >
        <el-icon><Document /></el-icon>
      </el-button>
      <el-tag v-if="showStatusTag" :type="statusTagType(task.status)" size="small">
        {{ statusLabel(task.status) }}
      </el-tag>
    </div>
  </div>

  <!-- 与任务抽屉条目头部一致：双行 + 可选定时按钮 -->
  <div v-else class="task-summary-row task-summary-row--stacked">
    <div class="task-summary-stacked-left">
      <div class="task-name-row">
        <el-button
          v-if="showScheduleButton"
          text
          circle
          size="small"
          class="task-schedule-btn"
          :aria-label="scheduledTaskAriaLabel"
          :title="scheduledTaskAriaLabel"
          @click.stop="emit('open-schedule-config', task)"
        >
          <el-icon><AlarmClock /></el-icon>
        </el-button>
        <div class="task-name">{{ pluginDisplayName }}</div>
      </div>
      <div class="task-counts">
        <span
          class="count-item count-success"
          :class="{ 'is-zero': successN === 0 }"
          :title="t('tasks.totalCount', { n: successN })"
        >
          <el-icon><CircleCheck /></el-icon>
          <span>{{ successN }}</span>
        </span>
        <span
          class="count-item count-failed"
          :class="{ 'is-zero': failedN === 0 }"
          :title="t('tasks.failedCount', { n: failedN })"
        >
          <el-icon><WarningFilled /></el-icon>
          <span>{{ failedN }}</span>
        </span>
        <span
          class="count-item count-deleted"
          :class="{ 'is-zero': deletedN === 0 }"
          :title="t('tasks.deletedCount', { n: deletedN })"
        >
          <el-icon><Delete /></el-icon>
          <span>{{ deletedN }}</span>
        </span>
        <span
          class="count-item count-dedup"
          :class="{ 'is-zero': dedupN === 0 }"
          :title="t('tasks.dedupCount', { n: dedupN })"
        >
          <el-icon><CopyDocument /></el-icon>
          <span>{{ dedupN }}</span>
        </span>
      </div>
    </div>
    <div class="task-summary-actions task-summary-actions--stacked">
      <el-button
        v-if="showRunParamsButton"
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.openRunParams')"
        @click.stop="emit('open-run-params')"
      >
        <el-icon><InfoFilled /></el-icon>
      </el-button>
      <el-button
        v-if="!stackedOmitImageLogActions"
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.drawerViewImages')"
        @click.stop="emit('open-task-images', task.id)"
      >
        <el-icon><Picture /></el-icon>
      </el-button>
      <el-button
        v-if="!stackedOmitImageLogActions"
        text
        circle
        size="small"
        class="task-action-icon"
        :title="t('tasks.drawerViewLog')"
        @click.stop="emit('open-task-log', task.id)"
      >
        <el-icon><Document /></el-icon>
      </el-button>
      <div v-if="showStatusTag" class="task-status-wrap">
        <el-tag :type="statusTagType(task.status)" size="small">
          {{ statusLabel(task.status) }}
        </el-tag>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import {
  AlarmClock,
  CircleCheck,
  CopyDocument,
  Delete,
  Document,
  InfoFilled,
  Picture,
  WarningFilled,
} from "@element-plus/icons-vue";
import { usePluginStore } from "../../stores/plugins";

/** 与 CrawlTask / 抽屉 ScriptTask 共用的最小字段 */
export type TaskSummaryRowTask = {
  id: string;
  pluginId: string;
  runConfigId?: string;
  triggerSource?: string;
  status: string;
  progress?: number;
  deletedCount?: number;
  dedupCount?: number;
  successCount?: number;
  failedCount?: number;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

const props = withDefaults(
  defineProps<{
    task: TaskSummaryRowTask;
    /** inline：自动配置侧栏单行；stacked：任务抽屉 */
    layout: "inline" | "stacked";
    showScheduleButton?: boolean;
    scheduledTaskAriaLabel?: string;
    showStatusTag?: boolean;
    /** 自动配置：悬停展示完整任务信息 */
    tooltipContent?: string;
    /** 打开「运行参数」弹窗的按钮（任务抽屉 / 自动配置列表） */
    showRunParamsButton?: boolean;
    /** 任务抽屉：图片/日志改由外侧文字按钮触发，隐藏本行图标按钮 */
    stackedOmitImageLogActions?: boolean;
  }>(),
  {
    showScheduleButton: false,
    scheduledTaskAriaLabel: "",
    showStatusTag: true,
    tooltipContent: "",
    showRunParamsButton: false,
    stackedOmitImageLogActions: false,
  },
);

const emit = defineEmits<{
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
  (e: "open-schedule-config", task: TaskSummaryRowTask): void;
  (e: "open-run-params"): void;
}>();

const { t } = useI18n();
const pluginStore = usePluginStore();

const pluginDisplayName = computed(() => pluginStore.pluginLabel(props.task.pluginId));

const successN = computed(() => Number(props.task.successCount ?? 0));
const failedN = computed(() => Number(props.task.failedCount ?? 0));
const deletedN = computed(() => Number(props.task.deletedCount ?? 0));
const dedupN = computed(() => Number(props.task.dedupCount ?? 0));

function statusTagType(s: string): "info" | "warning" | "success" | "danger" {
  const map: Record<string, "info" | "warning" | "success" | "danger"> = {
    pending: "info",
    running: "warning",
    completed: "success",
    failed: "danger",
    canceled: "info",
  };
  return map[s] || "info";
}

function statusLabel(s: string): string {
  const keyMap: Record<string, string> = {
    pending: "tasks.drawerTaskStatusPending",
    running: "tasks.drawerTaskStatusRunning",
    completed: "tasks.drawerTaskStatusCompleted",
    failed: "tasks.drawerTaskStatusFailed",
    canceled: "tasks.drawerTaskStatusCanceled",
  };
  const key = keyMap[s];
  return key ? t(key) : s;
}
</script>

<style scoped lang="scss">
.task-summary-row {
  box-sizing: border-box;
}

.task-summary-row--inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: min(100%, 360px);
  width: 100%;
  padding: 8px 10px;
  background: var(--anime-bg-card, var(--el-fill-color-blank));
  border: 1px solid var(--anime-border, var(--el-border-color));
  border-radius: 8px;
}

.task-summary-inline-grow {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.task-inline-inner {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 6px 8px;
  min-width: 0;
  width: 100%;
  overflow: hidden;
}

.task-inline-name {
  flex: 1 1 120px;
  min-width: 0;
  max-width: 100%;
  font-size: 13px;
  font-weight: 500;
  color: var(--anime-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-inline-stats {
  display: inline-flex;
  align-items: center;
  gap: 0;
  flex: 0 0 auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.task-inline-stat {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
  transition: opacity 0.15s ease;

  &.is-zero {
    opacity: 0.38;
  }

  &.count-success {
    color: #67c23a;
  }

  &.count-failed {
    color: #f56c6c;
  }

  &.count-deleted {
    color: var(--el-text-color-secondary, #909399);
  }

  &.count-dedup {
    color: var(--anime-text-muted, var(--el-text-color-secondary));
  }
}

.task-inline-sep {
  flex-shrink: 0;
  padding: 0 3px;
  font-size: 12px;
  line-height: 1;
  color: var(--anime-text-muted, var(--el-text-color-placeholder));
  user-select: none;
}

.task-summary-row--stacked {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}

.task-summary-stacked-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.task-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.task-schedule-btn {
  color: var(--el-color-warning);
  flex-shrink: 0;
}

.task-name {
  font-weight: 500;
  color: var(--anime-text-primary);
  font-size: 15px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-counts {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--anime-text-secondary);

  .count-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    transition: opacity 0.15s ease;

    .el-icon {
      font-size: 14px;
    }

    &.is-zero {
      opacity: 0.38;
    }
  }

  .count-success {
    color: #67c23a;
  }

  .count-failed {
    color: #f56c6c;
  }

  .count-deleted {
    color: var(--el-text-color-secondary, #909399);

    .el-icon,
    span {
      color: inherit;
    }
  }

  .count-dedup {
    color: var(--anime-text-muted);
  }
}

.task-summary-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.task-summary-actions--stacked {
  gap: 8px;
}

.task-action-icon {
  flex-shrink: 0;
}

.task-status-wrap {
  display: flex;
  align-items: center;
}

.task-summary-tooltip {
  white-space: pre-wrap;
  max-width: 300px;
  line-height: 1.45;
  font-size: 12px;
}
</style>
