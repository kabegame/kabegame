<template>
  <div class="task-panel-root">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <el-tag size="small" type="warning">进行中: {{ activeTasksCount }}</el-tag>
        <el-tag size="small" type="info">总任务: {{ tasks.length }}</el-tag>
      </div>
      <div class="toolbar-right">
        <el-button size="small" @click="$emit('refresh-downloads')">刷新下载</el-button>
        <el-button size="small" text :disabled="finishedTasksCount === 0" @click="$emit('clear-finished')">
          清除已结束 ({{ finishedTasksCount }})
        </el-button>
      </div>
    </div>

    <el-divider content-position="left">正在下载（{{ activeDownloads.length }}）</el-divider>
    <div v-if="activeDownloads.length === 0" class="empty">
      <el-empty description="暂无下载任务" :image-size="60" />
    </div>
    <div v-else class="downloads-list">
      <div v-for="d in activeDownloads" :key="downloadKey(d)" class="download-item">
        <div class="download-url" :title="d.url">{{ d.url }}</div>
        <div class="download-meta">
          <el-tag size="small" type="info">{{ d.plugin_id }}</el-tag>
          <el-tag size="small" type="warning">{{ d.state }}</el-tag>
          <el-tag size="small" type="info">task: {{ d.task_id }}</el-tag>
        </div>
      </div>
    </div>

    <el-divider content-position="left">任务（{{ tasks.length }}）</el-divider>
    <div v-if="tasks.length === 0" class="empty">
      <el-empty description="暂无任务" :image-size="60" />
    </div>
    <div v-else class="tasks-list">
      <div v-for="t in tasks" :key="t.id" class="task-item" :class="{ failed: t.status === 'failed' }">
        <div class="task-row">
          <div class="task-title">
            <div class="task-name" :title="t.pluginId">{{ t.pluginId }}</div>
            <el-tag size="small" :type="statusTagType(t.status)">{{ statusText(t.status) }}</el-tag>
          </div>
          <div class="task-actions">
            <el-button size="small" text circle title="查看任务详情" @click="$emit('open-task-detail', t.id)">
              <el-icon>
                <InfoFilled />
              </el-icon>
            </el-button>
            <el-button size="small" text circle title="查看任务图片" @click="$emit('open-task-images', t.id)">
              <el-icon>
                <Picture />
              </el-icon>
            </el-button>
            <el-button size="small" text circle title="删除任务" @click="$emit('delete-task', t.id)">
              <el-icon>
                <Delete />
              </el-icon>
            </el-button>
            <el-button v-if="t.status === 'pending' || t.status === 'running'" size="small" type="danger" plain
              @click="$emit('cancel-task', t.id)">
              取消
            </el-button>
          </div>
        </div>

        <el-progress v-if="t.status === 'running' || t.status === 'pending'" :percentage="Math.floor(t.progress || 0)"
          :stroke-width="10" />
        <div v-if="t.error" class="task-error">{{ t.error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Delete, InfoFilled, Picture } from "@element-plus/icons-vue";

type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  status: TaskStatus;
  progress: number;
  startTime?: number;
  endTime?: number;
  error?: string;
};

type ActiveDownloadInfo = {
  url: string;
  plugin_id: string;
  task_id: string;
  state: string;
  start_time: number;
};

defineProps<{
  tasks: ScriptTask[];
  activeDownloads: ActiveDownloadInfo[];
  activeTasksCount: number;
  finishedTasksCount: number;
}>();

defineEmits<{
  (e: "cancel-task", taskId: string): void;
  (e: "open-task-detail", taskId: string): void;
  (e: "open-task-images", taskId: string): void;
  (e: "delete-task", taskId: string): void;
  (e: "clear-finished"): void;
  (e: "refresh-downloads"): void;
}>();

function statusText(s: TaskStatus): string {
  switch (s) {
    case "pending":
      return "排队中";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
  }
}

function statusTagType(s: TaskStatus): "info" | "warning" | "success" | "danger" {
  switch (s) {
    case "pending":
      return "info";
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "canceled":
      return "info";
  }
}

function downloadKey(d: ActiveDownloadInfo) {
  return `${d.task_id}-${d.start_time}-${d.url}`;
}
</script>

<style scoped lang="scss">
.task-panel-root {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.empty {
  padding: 8px 0;
}

.downloads-list,
.tasks-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.download-item {
  padding: 8px 0;
  border-bottom: 1px dashed var(--anime-border);
}

.download-item:last-child {
  border-bottom: none;
}

.download-url {
  font-size: 12px;
  color: var(--anime-text-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-meta {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.task-item {
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.task-item.failed {
  border-color: rgba(245, 108, 108, 0.6);
}

.task-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.task-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-name {
  font-weight: 600;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-error {
  margin-top: 8px;
  font-size: 12px;
  color: #f56c6c;
  word-break: break-word;
}
</style>

