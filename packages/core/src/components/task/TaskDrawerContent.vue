<template>
  <div class="tasks-drawer-content">
    <!-- 下载信息区域 -->
    <div class="downloads-section">
      <div class="downloads-header">
        <span class="downloads-title">正在下载</span>
        <div class="downloads-stats">
          <el-tag type="warning" size="small">进行中: {{ activeDownloads.length }}</el-tag>
        </div>
      </div>
      <div v-if="activeDownloads.length === 0" class="downloads-empty">
        <el-empty description="暂无下载任务" :image-size="60" />
      </div>
      <div v-else class="downloads-content">
        <!-- 正在下载的图片列表 -->
        <div v-if="activeDownloads.length > 0" class="downloads-list">
          <div v-for="download in activeDownloads" :key="downloadKey(download)" class="download-item">
            <div class="download-info">
              <div class="download-url" :title="download.url">{{ download.url }}</div>
              <div class="download-meta">
                <el-tag size="small" type="info">{{ download.plugin_id }}</el-tag>
                <span
                  v-if="isShimmerState(download)"
                  class="download-state-text shimmer-text"
                  :title="downloadStateText(download)"
                >
                  {{ downloadStateText(download) }}
                </span>
                <el-tag v-else size="small" :type="downloadStateTagType(download)">
                  {{ downloadStateText(download) }}
                </el-tag>
              </div>
              <div
                v-if="shouldShowDownloadProgress(download) && downloadProgressText(download)"
                class="download-progress"
              >
                <el-progress
                  :percentage="downloadProgressPercent(download)"
                  :format="() => downloadProgressText(download)!"
                  :stroke-width="10"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="tasks-summary">
      <span>共 {{ tasks.length }} 个任务</span>
      <el-button
        text
        size="small"
        class="clear-completed-btn"
        :disabled="nonRunningTasksCount === 0"
        @click="$emit('clear-finished-tasks')"
      >
        清除所有任务 ({{ nonRunningTasksCount }})
      </el-button>
    </div>
    <transition-group name="task-move" tag="div" class="tasks-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-item"
        :class="{ 'task-item-failed': task.status === 'failed' }"
        @contextmenu="(e) => handleTaskContextMenu(e, task)"
      >
        <div class="task-close">
          <el-button text circle size="small" class="close-btn" title="删除任务" @click="$emit('delete-task', task.id)">
            <el-icon>
              <Close />
            </el-icon>
          </el-button>
        </div>
        <div class="task-header">
          <div class="task-info">
            <div class="task-name">{{ getPluginName(task.pluginId) }}</div>
          </div>
          <div class="task-header-right">
            <el-button
              text
              circle
              size="small"
              class="task-detail-btn"
              title="查看任务图片"
              @click.stop="$emit('open-task-images', task.id)"
            >
              <el-icon>
                <Picture />
              </el-icon>
            </el-button>
            <div class="task-status">
              <el-tag :type="getStatusType(task.status)" size="small">
                {{ getStatusText(task.status) }}
              </el-tag>
            </div>
          </div>
        </div>

        <!-- 展开的运行参数（不使用 v-if/v-show，避免 display:none；用高度动画折叠） -->
        <div class="task-params-wrap" :class="{ 'is-open': expandedTasks.has(task.id) }">
          <div class="task-params">
            <div class="param-item">
              <span class="param-label">源：</span>
              <span class="param-value">{{ getPluginName(task.pluginId) }}</span>
            </div>
            <div v-if="task.startTime" class="param-item">
              <span class="param-label">开始时间：</span>
              <span class="param-value">
                <el-icon style="margin-right: 6px;">
                  <Clock />
                </el-icon>
                {{ formatDate(task.startTime) }}
              </span>
            </div>
            <div v-if="task.endTime" class="param-item">
              <span class="param-label">结束时间：</span>
              <span class="param-value">
                <el-icon style="margin-right: 6px;">
                  <Clock />
                </el-icon>
                {{ formatDate(task.endTime) }}
              </span>
            </div>
            <div v-else-if="task.startTime" class="param-item">
              <span class="param-label">结束时间：</span>
              <span class="param-value">进行中</span>
            </div>
            <div v-if="task.startTime" class="param-item">
              <span class="param-label">耗时：</span>
              <span class="param-value">{{ formatDuration(task.startTime, task.endTime) }}</span>
            </div>
            <div v-if="task.deletedCount > 0" class="param-item">
              <span class="param-label">已删除：</span>
              <span class="param-value">{{ task.deletedCount }} 张</span>
            </div>
            <div v-if="task.outputDir" class="param-item">
              <span class="param-label">输出目录：</span>
              <span class="param-value">{{ task.outputDir }}</span>
            </div>
            <div v-if="task.userConfig && Object.keys(task.userConfig).length > 0" class="param-item">
              <span class="param-label">配置参数：</span>
              <div class="param-config">
                <div v-for="(value, key) in task.userConfig" :key="key" class="config-item">
                  <span class="config-key">{{ getVarDisplayName(task.pluginId, String(key)) }}：</span>
                  <span class="config-value">{{ formatConfigValue(task.pluginId, String(key), value) }}</span>
                </div>
              </div>
            </div>

            <!-- 失败信息（放到详情里） -->
            <div v-if="task.status === 'failed'" class="task-error">
              <div v-if="task.progress > 0" class="task-progress">
                <el-progress :percentage="Math.round(task.progress)" status="exception" />
              </div>
              <div class="error-message">
                <el-icon class="error-icon">
                  <WarningFilled />
                </el-icon>
                <span class="error-text">{{ task.error || "执行失败" }}</span>
                <el-button text size="small" class="copy-error-btn" title="复制错误信息和运行参数" @click="handleCopyError(task)">
                  <el-icon>
                    <CopyDocument />
                  </el-icon>
                </el-button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="task.status === 'running'" class="task-progress">
          <el-progress :percentage="Math.round(task.progress)" :status="task.status === 'running' ? undefined : 'success'" />
          <div class="progress-footer">
            <el-button text size="small" type="warning" class="stop-btn" @click.stop="$emit('cancel-task', task.id)">
              停止
            </el-button>
          </div>
        </div>

        <!-- 展开/收起箭头：底部整条都是触发区域 -->
        <div class="task-expand-bottom" role="button" tabindex="0" @click.stop="toggleTaskExpand(task.id, task.pluginId)">
          <el-icon :class="{ 'rotate-180': expandedTasks.has(task.id) }">
            <ArrowDown />
          </el-icon>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ArrowDown, Clock, Close, CopyDocument, Picture, WarningFilled } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";

type VarOption = string | { name: string; variable: string };
type PluginVarMeta = {
  name: string;
  type?: string;
  optionNameByVariable?: Record<string, string>;
};

type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  status: TaskStatus | string;
  progress: number;
  deletedCount?: number;
  outputDir?: string | null;
  userConfig?: Record<string, any> | null;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

type ActiveDownloadInfo = {
  url: string;
  plugin_id: string;
  start_time: number;
  task_id: string;
  state?: string;
};

type DownloadProgressPayload = {
  taskId: string;
  url: string;
  startTime: number;
  pluginId: string;
  receivedBytes: number;
  totalBytes?: number | null;
};

type DownloadProgressState = {
  receivedBytes: number;
  totalBytes?: number | null;
  updatedAt: number;
};

type DownloadStatePayload = {
  taskId: string;
  url: string;
  startTime: number;
  pluginId: string;
  state: string;
  error?: string;
};

const props = withDefaults(
  defineProps<{
    tasks: ScriptTask[];
    plugins?: Array<{ id: string; name?: string }>;
    /** active=false 时停止下载轮询与事件监听（main drawer 关闭时用） */
    active?: boolean;
    /** plugin-editor 可关闭右键菜单 */
    enableContextMenu?: boolean;
  }>(),
  { plugins: () => [], active: true, enableContextMenu: true }
);

const emit = defineEmits<{
  (e: "delete-task", taskId: string): void;
  (e: "cancel-task", taskId: string): void;
  (e: "open-task-images", taskId: string): void;
  (e: "clear-finished-tasks"): void;
  (e: "task-contextmenu", payload: { x: number; y: number; task: ScriptTask }): void;
}>();

const nonRunningTasksCount = computed(
  () => props.tasks.filter((t) => t.status !== "running" && t.status !== "pending").length
);

const expandedTasks = ref(new Set<string>());
const pluginVarMetaMap = ref<Record<string, Record<string, PluginVarMeta>>>({});

// 下载信息
const activeDownloads = ref<ActiveDownloadInfo[]>([]);
let downloadRefreshInterval: number | null = null;

const downloadProgressByKey = ref<Record<string, DownloadProgressState>>({});
let unlistenDownloadProgress: null | (() => void) = null;

const downloadStateByKey = ref<Record<string, { state: string; error?: string; updatedAt: number }>>({});
let unlistenDownloadState: null | (() => void) = null;

const downloadKey = (d: ActiveDownloadInfo) => `${d.task_id}::${d.start_time}::${d.url}`;
const downloadKeyFromPayload = (p: DownloadProgressPayload) => `${p.taskId}::${p.startTime}::${p.url}`;
const downloadStateKeyFromPayload = (p: DownloadStatePayload) => `${p.taskId}::${p.startTime}::${p.url}`;

const getEffectiveDownloadState = (d: ActiveDownloadInfo) => {
  const key = downloadKey(d);
  return downloadStateByKey.value[key]?.state || d.state || "downloading";
};

const shouldShowDownloadProgress = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  return st === "downloading";
};

const isShimmerState = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  return st === "processing" || st === "extracting";
};

const downloadStateText = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  const map: Record<string, string> = {
    preparing: "准备中",
    extracting: "解压中",
    downloading: "下载中",
    processing: "处理中",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
  };
  return map[st] || st;
};

const downloadStateTagType = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  if (st === "failed") return "danger";
  if (st === "canceled") return "info";
  if (st === "completed") return "success";
  if (st === "processing") return "success";
  if (st === "extracting") return "warning";
  if (st === "downloading") return "warning";
  return "info";
};

const formatBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
};

const downloadProgressPercent = (d: ActiveDownloadInfo) => {
  const p = downloadProgressByKey.value[downloadKey(d)];
  if (!p) return 0;
  const total = p.totalBytes ?? null;
  if (!total || total <= 0) return 0;
  const pct = Math.floor((p.receivedBytes / total) * 100);
  return Math.max(0, Math.min(100, pct));
};

const downloadProgressText = (d: ActiveDownloadInfo) => {
  const p = downloadProgressByKey.value[downloadKey(d)];
  if (!p) return null;
  const total = p.totalBytes ?? null;
  if (!total || total <= 0) return `${formatBytes(p.receivedBytes)} / ?`;
  return `${formatBytes(p.receivedBytes)} / ${formatBytes(total)}`;
};

const loadDownloads = async () => {
  try {
    const downloads = await invoke<ActiveDownloadInfo[]>("get_active_downloads");
    activeDownloads.value = downloads;

    // 清理已不在 active 列表里的进度，避免内存增长
    const aliveKeys = new Set(downloads.map(downloadKey));
    const next: Record<string, DownloadProgressState> = {};
    for (const [k, v] of Object.entries(downloadProgressByKey.value)) {
      if (aliveKeys.has(k)) next[k] = v;
    }
    downloadProgressByKey.value = next;

    // 状态缓存：保留活跃项，同时用后端快照纠正“错过事件”导致的状态卡死
    const nextState: Record<string, { state: string; error?: string; updatedAt: number }> = {};
    for (const [k, v] of Object.entries(downloadStateByKey.value)) {
      if (aliveKeys.has(k)) nextState[k] = v;
    }
    for (const d of downloads) {
      const k = downloadKey(d);
      const snapshotState = d.state || "downloading";
      const cached = nextState[k];
      if (!cached || cached.state !== snapshotState) {
        nextState[k] = { state: snapshotState, error: cached?.error, updatedAt: Date.now() };
      }
    }
    downloadStateByKey.value = nextState;
  } catch (error) {
    console.error("加载下载列表失败:", error);
  }
};

let eventListenersInitialized = false;
const initEventListeners = async () => {
  if (eventListenersInitialized) return;
  eventListenersInitialized = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenDownloadProgress = await listen<DownloadProgressPayload>("download-progress", (event) => {
      const p = event.payload;
      const key = downloadKeyFromPayload(p);
      downloadProgressByKey.value = {
        ...downloadProgressByKey.value,
        [key]: {
          receivedBytes: Number(p.receivedBytes || 0),
          totalBytes: p.totalBytes ?? null,
          updatedAt: Date.now(),
        },
      };
    });
  } catch (error) {
    console.error("监听下载进度失败:", error);
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenDownloadState = await listen<DownloadStatePayload>("download-state", (event) => {
      const p = event.payload;
      const key = downloadStateKeyFromPayload(p);
      downloadStateByKey.value = {
        ...downloadStateByKey.value,
        [key]: { state: p.state, error: p.error, updatedAt: Date.now() },
      };
    });
  } catch (error) {
    console.error("监听下载状态失败:", error);
  }
};

const startDownloadLoop = async () => {
  await initEventListeners();
  await loadDownloads();
  if (downloadRefreshInterval === null) {
    downloadRefreshInterval = window.setInterval(loadDownloads, 1000);
  }
};

const stopDownloadLoop = () => {
  if (downloadRefreshInterval !== null) {
    clearInterval(downloadRefreshInterval);
    downloadRefreshInterval = null;
  }
};

const getPluginName = (pluginId: string) => {
  const plugin = (props.plugins || []).find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

const formatDate = (timestamp: number) => {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return new Date(ms).toLocaleString("zh-CN");
};

const formatDuration = (startTime: number, endTime?: number) => {
  const startMs = startTime > 1e12 ? startTime : startTime * 1000;
  const endMs = endTime ? (endTime > 1e12 ? endTime : endTime * 1000) : Date.now();
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
};

const getStatusType = (status: string) => {
  const map: Record<string, string> = {
    pending: "info",
    running: "warning",
    completed: "success",
    failed: "danger",
    canceled: "info",
  };
  return map[status] || "info";
};

const getStatusText = (status: string) => {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "完成",
    failed: "失败",
    canceled: "已取消",
  };
  return map[status] || status;
};

const ensurePluginVars = async (pluginId: string) => {
  if (pluginVarMetaMap.value[pluginId]) return;
  try {
    const vars = await invoke<Array<{ key: string; name: string; type?: string; options?: VarOption[] }> | null>(
      "get_plugin_vars",
      { pluginId }
    );
    const metaMap: Record<string, PluginVarMeta> = {};
    (vars || []).forEach((v) => {
      const display = v.name || v.key;
      const optionNameByVariable: Record<string, string> = {};
      (v.options || []).forEach((opt) => {
        if (typeof opt === "string") optionNameByVariable[opt] = opt;
        else optionNameByVariable[opt.variable] = opt.name;
      });
      metaMap[v.key] = {
        name: display,
        type: v.type,
        optionNameByVariable: Object.keys(optionNameByVariable).length ? optionNameByVariable : undefined,
      };
    });
    pluginVarMetaMap.value = { ...pluginVarMetaMap.value, [pluginId]: metaMap };
  } catch (error) {
    console.error("加载插件变量定义失败:", pluginId, error);
    pluginVarMetaMap.value = { ...pluginVarMetaMap.value, [pluginId]: {} };
  }
};

const getVarDisplayName = (pluginId: string, key: string) => pluginVarMetaMap.value[pluginId]?.[key]?.name || key;

const formatConfigValue = (pluginId: string, key: string, value: any): string => {
  const meta = pluginVarMetaMap.value[pluginId]?.[key];
  const map = meta?.optionNameByVariable || {};
  if (value === null || value === undefined) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? map[v] || v : String(v))).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, any>);
    if (entries.length > 0 && entries.every(([, v]) => typeof v === "boolean")) {
      const selected = entries.filter(([, v]) => v === true).map(([k]) => k);
      const named = selected.map((v) => map[v] || v);
      return named.length > 0 ? named.join(", ") : "未选择";
    }
    return JSON.stringify(value, null, 2);
  }
  const s = String(value);
  return map[s] || s;
};

async function toggleTaskExpand(taskId: string, pluginId: string) {
  if (expandedTasks.value.has(taskId)) {
    expandedTasks.value.delete(taskId);
    return;
  }
  await ensurePluginVars(pluginId);
  expandedTasks.value.add(taskId);
}

function handleTaskContextMenu(event: MouseEvent, task: ScriptTask) {
  event.preventDefault();
  if (!props.enableContextMenu) return;
  emit("task-contextmenu", { x: event.clientX, y: event.clientY, task });
}

async function handleCopyError(task: ScriptTask) {
  let text = "=== 任务错误信息 ===\n";
  text += `错误：${task.error || "执行失败"}\n\n`;
  text += "=== 运行参数 ===\n";
  text += `源：${getPluginName(task.pluginId)}\n`;
  if (task.outputDir) text += `输出目录：${task.outputDir}\n`;
  if (task.userConfig && Object.keys(task.userConfig).length > 0) {
    text += "配置参数：\n";
    for (const [key, value] of Object.entries(task.userConfig)) {
      text += `  ${key}：${formatConfigValue(task.pluginId, String(key), value)}\n`;
    }
  }
  if (task.startTime) text += `开始时间：${formatDate(task.startTime)}\n`;
  if (task.endTime) text += `结束时间：${formatDate(task.endTime)}\n`;
  text += `进度：${Math.round(Number(task.progress || 0))}%\n`;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制到剪贴板");
  } catch (error) {
    console.error("复制失败:", error);
    ElMessage.error("复制失败");
  }
}

watch(
  () => !!props.active,
  async (val) => {
    if (val) await startDownloadLoop();
    else stopDownloadLoop();
  },
  { immediate: true }
);

onUnmounted(() => {
  stopDownloadLoop();
  try {
    unlistenDownloadProgress?.();
  } catch {
    // ignore
  } finally {
    unlistenDownloadProgress = null;
  }
  try {
    unlistenDownloadState?.();
  } catch {
    // ignore
  } finally {
    unlistenDownloadState = null;
  }
});
</script>

<style scoped lang="scss">
.tasks-drawer-content {
  display: flex;
  flex-direction: column;
  height: 100%;

  .downloads-section {
    padding: 16px;
    border-bottom: 1px solid var(--anime-border);
    background: var(--anime-bg-secondary);

    .downloads-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;

      .downloads-title {
        font-size: 15px;
        font-weight: 600;
        color: var(--anime-text-primary);
      }

      .downloads-stats {
        display: flex;
        gap: 8px;
      }
    }

    .downloads-empty {
      padding: 20px 0;
    }

    .downloads-content {
      .downloads-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 200px;
        overflow-y: auto;
        margin-bottom: 12px;

        .download-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: var(--anime-bg-card);
          border-radius: 6px;
          border: 1px solid var(--anime-border);

          .download-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 4px;

            .download-url {
              font-size: 12px;
              color: var(--anime-text-primary);
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .download-meta {
              display: flex;
              align-items: center;
              gap: 8px;

              .download-state-text {
                font-size: 12px;
                font-weight: 600;
                max-width: 160px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }

              .shimmer-text {
                color: var(--anime-text-primary);
                background: linear-gradient(
                  90deg,
                  rgba(255, 255, 255, 0.15) 0%,
                  rgba(255, 255, 255, 0.85) 50%,
                  rgba(255, 255, 255, 0.15) 100%
                );
                background-size: 200% 100%;
                -webkit-background-clip: text;
                background-clip: text;
                -webkit-text-fill-color: transparent;
                animation: shimmer-move 1.25s linear infinite;
              }
            }

            .download-progress {
              margin-top: 6px;
            }
          }
        }
      }

      .queue-info {
        padding: 8px 0;
      }
    }
  }

  .tasks-summary {
    padding: 16px;
    border-bottom: 1px solid var(--anime-border);
    font-size: 14px;
    color: var(--anime-text-secondary);
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tasks-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    flex: 1;
    overflow-y: auto;
    position: relative;
    min-height: 0;
  }

  .task-item {
    padding: 16px;
    background: var(--anime-bg-card);
    border-radius: 8px;
    border: 1px solid var(--anime-border);
    transition: all 0.3s ease;
    position: relative;

    &.task-item-failed {
      background: rgba(239, 68, 68, 0.05);
      border-color: rgba(239, 68, 68, 0.2);

      &:hover {
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.3);
      }
    }

    &:hover {
      background: rgba(0, 0, 0, 0.02);
      border-color: var(--anime-border);
    }

    .task-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .task-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }

    .task-name {
      font-weight: 500;
      color: var(--anime-text-primary);
      font-size: 15px;
    }

    .task-time {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--anime-text-secondary);

      .el-icon {
        font-size: 14px;
      }
    }

    .task-progress {
      margin-top: 8px;
    }

    .progress-text {
      display: block;
      font-size: 12px;
      color: var(--anime-text-secondary);
      text-align: right;
    }

    .progress-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;

      .progress-text {
        margin-top: 0;
        text-align: right;
      }

      .stop-btn {
        padding: 0;
        height: auto;
        font-size: 12px;
      }
    }

    .task-error {
      margin-top: 8px;
      padding: 12px;
      background: rgba(239, 68, 68, 0.1);
      border-radius: 8px;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .error-message {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      color: var(--anime-text-primary);
    }

    .copy-error-btn {
      margin-left: auto;
      flex-shrink: 0;
      color: var(--anime-text-secondary);
      transition: color 0.2s ease;

      &:hover {
        color: var(--anime-primary);
      }
    }

    .error-icon {
      color: #ef4444;
      font-size: 18px;
      flex-shrink: 0;
    }

    .error-text {
      flex: 1;
      font-size: 14px;
      word-break: break-word;
      line-height: 1.5;
    }

    .task-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .task-close {
      position: absolute;
      top: -10px;
      right: -10px;
      z-index: 3;

      .close-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        color: var(--anime-text-secondary);
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
        background: var(--el-bg-color-overlay, #fff);
        border: 1px solid var(--el-border-color, #dcdfe6);

        &:hover {
          color: var(--anime-primary);
          background: #fff;
          transform: translateY(-1px);
        }
      }
    }

    .task-expand-bottom {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 0 6px 0;
      margin-top: 8px;
      width: 100%;
      border-top: 1px dashed rgba(0, 0, 0, 0.06);
      cursor: pointer;
      color: var(--anime-text-secondary);

      .el-icon {
        transition: transform 0.25s ease, color 0.2s ease;
      }

      &:hover {
        color: var(--anime-primary);
        background: rgba(0, 0, 0, 0.02);
      }

      :deep(.rotate-180) {
        transform: rotate(180deg);
      }
    }

    .task-params-wrap {
      /* 不用 v-show(display:none)，用高度动画折叠；padding-top 也参与动画避免“突然少一截” */
      max-height: 0;
      opacity: 0;
      padding-top: 0;
      overflow: hidden;
      transition: max-height 0.25s ease, opacity 0.2s ease, padding-top 0.25s ease;

      &.is-open {
        max-height: 900px;
        opacity: 1;
        padding-top: 12px;
      }
    }

    .task-params {
      margin-top: 0;
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 6px;
      border: 1px solid var(--anime-border);
      font-size: 13px;
    }

    .param-item {
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .param-label {
      color: var(--anime-text-secondary);
      font-weight: 500;
      font-size: 12px;
      flex-shrink: 0;
    }

    .param-value {
      color: var(--anime-text-primary);
      word-break: break-all;
      font-size: 13px;
      padding-left: 8px;
    }

    .param-config {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .config-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-left: 8px;
      margin-bottom: 8px;

      &:last-child {
        margin-bottom: 0;
      }
    }

    .config-key {
      color: var(--anime-text-secondary);
      font-size: 12px;
      font-weight: 500;
    }

    .config-value {
      color: var(--anime-text-primary);
      font-size: 13px;
      word-break: break-all;
      padding-left: 8px;
    }

    .task-images-section {
      margin-top: 8px;
    }

    .task-images-list {
      margin-top: 8px;
    }

    .loading-images {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      color: var(--anime-text-secondary);
      font-size: 13px;
    }

    .task-images-path-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 300px;
      overflow-y: auto;
    }

    .task-image-path-item {
      padding: 4px 0;
    }

    .path-button {
      width: 100%;
      justify-content: flex-start;
      padding: 6px 8px;
      font-size: 12px;
    }

    .path-text {
      margin-left: 6px;
      flex: 1;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .load-more-container {
      margin-top: 8px;
      text-align: center;
    }

    .load-more-btn {
      font-size: 12px;
      color: var(--anime-text-secondary);
    }

    .loading-more {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px;
      color: var(--anime-text-secondary);
      font-size: 12px;
    }

    .no-images {
      padding: 12px;
      text-align: center;
      color: var(--anime-text-secondary);
      font-size: 13px;
    }
  }
}

@keyframes shimmer-move {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.task-move-enter-active,
.task-move-leave-active {
  transition: all 0.25s ease;
}

.task-move-move {
  transition: transform 0.25s ease;
}

.task-move-leave-active {
  position: absolute;
  width: 100%;
}

.task-move-enter-from,
.task-move-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>

