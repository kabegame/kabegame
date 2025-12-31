<template>
  <el-drawer v-model="visible" title="任务列表" :size="400" direction="rtl" :with-header="true" :append-to-body="true"
    :modal-class="'task-drawer-modal'" @open="handleDrawerOpen">
    <div class="tasks-drawer-content">
      <!-- 下载信息区域 -->
      <div class="downloads-section">
        <div class="downloads-header">
          <span class="downloads-title">正在下载</span>
          <div class="downloads-stats">
            <el-tag type="info" size="small">队列: {{ queueSize }}</el-tag>
            <el-tag type="warning" size="small">进行中: {{ activeDownloads.length }}</el-tag>
            <el-button text size="small" type="danger" :disabled="queueSize === 0" @click="handleClearDownloadQueue">
              终止队列
            </el-button>
          </div>
        </div>
        <div v-if="activeDownloads.length === 0 && queueSize === 0" class="downloads-empty">
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
                  <span v-if="isShimmerState(download)" class="download-state-text shimmer-text"
                    :title="downloadStateText(download)">
                    {{ downloadStateText(download) }}
                  </span>
                  <el-tag v-else size="small" :type="downloadStateTagType(download)">
                    {{ downloadStateText(download) }}
                  </el-tag>
                </div>
                <div class="download-progress"
                  v-if="shouldShowDownloadProgress(download) && downloadProgressText(download)">
                  <el-progress :percentage="downloadProgressPercent(download)"
                    :format="() => downloadProgressText(download)!" :stroke-width="10" />
                </div>
              </div>
            </div>
          </div>
          <!-- 队列信息 -->
          <div v-if="queueSize > 0" class="queue-info">
            <el-alert :title="`还有 ${queueSize} 个任务在队列中等待下载`" type="info" :closable="false" show-icon />
          </div>
        </div>
      </div>

      <div class="tasks-summary">
        <span>共 {{ tasks.length }} 个任务</span>
        <el-button text size="small" class="clear-completed-btn" @click="handleDeleteCompletedTasks"
          :disabled="completedTaskCount === 0">
          清理已完成 ({{ completedTaskCount }})
        </el-button>
      </div>
      <transition-group name="task-move" tag="div" class="tasks-list">
        <div v-for="task in tasks" :key="task.id" class="task-item"
          :class="{ 'task-item-failed': task.status === 'failed' }" @contextmenu="openTaskContextMenu($event, task)">
          <div class="task-close">
            <el-button text circle size="small" @click="handleDeleteTask(task)" class="close-btn" title="删除任务">
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
              <div class="param-item" v-if="task.startTime">
                <span class="param-label">开始时间：</span>
                <span class="param-value">
                  <el-icon style="margin-right: 6px;">
                    <Clock />
                  </el-icon>
                  {{ formatDate(task.startTime) }}
                </span>
              </div>
              <div class="param-item" v-if="task.endTime">
                <span class="param-label">结束时间：</span>
                <span class="param-value">
                  <el-icon style="margin-right: 6px;">
                    <Clock />
                  </el-icon>
                  {{ formatDate(task.endTime) }}
                </span>
              </div>
              <div class="param-item" v-else-if="task.startTime">
                <span class="param-label">结束时间：</span>
                <span class="param-value">进行中</span>
              </div>
              <div class="param-item" v-if="task.startTime">
                <span class="param-label">耗时：</span>
                <span class="param-value">{{ formatDuration(task.startTime, task.endTime) }}</span>
              </div>
              <div class="param-item" v-if="task.url">
                <span class="param-label">URL：</span>
                <span class="param-value">{{ task.url }}</span>
              </div>
              <div class="param-item" v-if="task.outputDir">
                <span class="param-label">输出目录：</span>
                <span class="param-value">{{ task.outputDir }}</span>
              </div>
              <div class="param-item" v-if="task.userConfig && Object.keys(task.userConfig).length > 0">
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
                  <span class="progress-text">{{ task.downloadedImages }} / {{ task.totalImages }}</span>
                </div>
                <div class="error-message">
                  <el-icon class="error-icon">
                    <WarningFilled />
                  </el-icon>
                  <span class="error-text">{{ task.error || '执行失败' }}</span>
                  <el-button text size="small" @click="handleCopyError(task)" class="copy-error-btn"
                    title="复制错误信息和运行参数">
                    <el-icon>
                      <CopyDocument />
                    </el-icon>
                  </el-button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="task.status === 'running'" class="task-progress">
            <el-progress :percentage="Math.round(task.progress)"
              :status="task.status === 'running' ? undefined : 'success'" />
            <div class="progress-footer">
              <el-button text size="small" type="warning" @click.stop="handleStopTask(task)" class="stop-btn">
                停止
              </el-button>
            </div>
          </div>

          <!-- 展开/收起箭头：底部整条都是触发区域 -->
          <div class="task-expand-bottom" @click.stop="toggleTaskExpand(task.id)" role="button" tabindex="0">
            <el-icon :class="{ 'rotate-180': expandedTasks.has(task.id) }">
              <ArrowDown />
            </el-icon>
          </div>
        </div>
      </transition-group>
    </div>
  </el-drawer>

  <el-dialog v-model="taskViewerVisible" :title="`任务文件 - ${viewerTaskName || '未命名任务'}`" width="82%" top="5vh"
    class="task-images-dialog" @close="handleViewerClose" :destroy-on-close="true">
    <div class="task-images-viewer">
      <div v-if="viewerLoading && viewerImages.length === 0" class="viewer-loading">
        <el-icon class="is-loading">
          <Loading />
        </el-icon>
        <span>加载中...</span>
      </div>
      <div v-else-if="viewerImages.length === 0" class="viewer-empty">
        <el-icon>
          <Picture />
        </el-icon>
        <span>暂无文件</span>
      </div>
      <div v-else>
        <ImageGrid :images="viewerImages" :image-url-map="viewerImageUrls" :image-click-action="'open'"
          :columns="viewerColumns" :aspect-ratio-match-window="viewerAspectRatioMatchWindow"
          :window-aspect-ratio="viewerWindowAspect" :selected-images="viewerSelected"
          @image-click="handleViewerImageClick" @image-dbl-click="handleViewerImageDblClick" />
        <div class="viewer-actions">
          <el-button :disabled="viewerImages.length === 0" @click="handleSaveViewerToAlbum">
            保存为画册
          </el-button>
          <el-button v-if="viewerHasMore" :loading="viewerLoadingMore" @click="loadViewerPage(false)">
            加载更多
          </el-button>
          <span class="viewer-count">共 {{ viewerImages.length }} 张</span>
        </div>
      </div>
    </div>
  </el-dialog>

  <AddToAlbumDialog v-model="addToAlbumVisible" :image-ids="addToAlbumImageIds" />

  <el-dialog v-model="saveConfigVisible" title="保存为运行配置" width="520px" :close-on-click-modal="false"
    class="save-config-dialog" @close="resetSaveConfigForm">
    <el-form label-width="80px">
      <el-form-item label="名称" required>
        <el-input v-model="saveConfigName" placeholder="请输入配置名称" />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="saveConfigDescription" placeholder="可选：配置说明" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="saveConfigVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingConfig" @click="confirmSaveTaskAsConfig">保存</el-button>
    </template>
  </el-dialog>

  <TaskContextMenu :visible="contextMenuVisible" :position="contextMenuPos" :task="contextMenuTask"
    @close="closeContextMenu" @command="handleContextAction" />
</template>

<script setup lang="ts">
import { ref, computed, shallowRef, onUnmounted, onMounted, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Clock, ArrowDown, Loading, WarningFilled, CopyDocument, Picture, Close } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import ImageGrid from "./ImageGrid.vue";
import TaskContextMenu from "./TaskContextMenu.vue";
import type { ImageInfo } from "@/stores/crawler";
import AddToAlbumDialog from "./AddToAlbumDialog.vue";

interface ActiveDownloadInfo {
  url: string;
  plugin_id: string;
  start_time: number;
  task_id: string;
  state?: string;
}

interface Props {
  modelValue: boolean;
  tasks: any[];
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});

const expandedTasks = ref(new Set<string>());
const VIEWER_PAGE_SIZE = 50;

// 任务文件查看弹窗
const taskViewerVisible = ref(false);
const viewerTaskId = ref<string>("");
const viewerTaskName = ref<string>("");
const viewerImages = shallowRef<ImageInfo[]>([]);
const viewerImageUrls = ref<Record<string, { thumbnail?: string; original?: string }>>({});
const viewerPage = ref(0);
const viewerHasMore = ref(false);
const viewerLoading = ref(false);
const viewerLoadingMore = ref(false);
const viewerBlobUrls = new Set<string>();
const viewerSelected = ref<Set<string>>(new Set());
const viewerColumns = ref(0);
const viewerAspectRatioMatchWindow = ref(false);
const viewerWindowAspect = ref(16 / 9);
type VarOption = string | { name: string; variable: string };
type PluginVarMeta = {
  name: string;
  type?: string;
  optionNameByVariable?: Record<string, string>;
};
const pluginVarMetaMap = ref<Record<string, Record<string, PluginVarMeta>>>({});

// 任务文件 -> 保存为画册
const addToAlbumVisible = ref(false);
const addToAlbumImageIds = computed(() => viewerImages.value.map((i) => i.id));

// 任务右键菜单
const contextMenuVisible = ref(false);
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTask = ref<any | null>(null);

// 保存为运行配置弹窗
const saveConfigVisible = ref(false);
const savingConfig = ref(false);
const saveConfigTask = ref<any | null>(null);
const saveConfigName = ref("");
const saveConfigDescription = ref("");

const plugins = computed(() => pluginStore.plugins);
const completedTaskCount = computed(() => props.tasks.filter((t) => t.status === "completed").length);

// 下载信息
const activeDownloads = ref<ActiveDownloadInfo[]>([]);
const queueSize = ref(0);
let downloadRefreshInterval: number | null = null;

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

const downloadProgressByKey = ref<Record<string, DownloadProgressState>>({});
let unlistenDownloadProgress: null | (() => void) = null;

const downloadKey = (d: ActiveDownloadInfo) => `${d.task_id}::${d.start_time}::${d.url}`;
const downloadKeyFromPayload = (p: DownloadProgressPayload) => `${p.taskId}::${p.startTime}::${p.url}`;

type DownloadStatePayload = {
  taskId: string;
  url: string;
  startTime: number;
  pluginId: string;
  state: string;
  error?: string;
};

const downloadStateByKey = ref<Record<string, { state: string; error?: string; updatedAt: number }>>(
  {}
);
let unlistenDownloadState: null | (() => void) = null;

const downloadStateKeyFromPayload = (p: DownloadStatePayload) =>
  `${p.taskId}::${p.startTime}::${p.url}`;

const getEffectiveDownloadState = (d: ActiveDownloadInfo) => {
  const key = downloadKey(d);
  return downloadStateByKey.value[key]?.state || d.state || "downloading";
};

const shouldShowDownloadProgress = (d: ActiveDownloadInfo) => {
  // 只在下载中显示进度条；下载完成后立刻隐藏进度条，改展示后续状态
  const st = getEffectiveDownloadState(d);
  return st === "downloading";
};

const isShimmerState = (d: ActiveDownloadInfo) => {
  // “正在进行的操作”用反光文字表示
  const st = getEffectiveDownloadState(d);
  return (
    st === "downloaded" ||
    st === "processing" ||
    st === "dedupe_check" ||
    st === "db_inserting"
  );
};

const downloadStateText = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  const map: Record<string, string> = {
    queued: "队列等待",
    downloading: "下载中",
    downloaded: "下载完成",
    reused: "已复用",
    processing: "处理中",
    dedupe_check: "去重检查",
    db_inserting: "写入数据库",
    db_added: "已入库",
    dedupe_skipped: "去重跳过",
    notified: "已通知画廊",
    failed: "失败",
    canceled: "已取消",
  };
  return map[st] || st;
};

const downloadStateTagType = (d: ActiveDownloadInfo) => {
  const st = getEffectiveDownloadState(d);
  if (st === "failed") return "danger";
  if (st === "canceled") return "info";
  if (st === "dedupe_skipped") return "warning";
  if (st === "db_added" || st === "notified") return "success";
  if (st === "processing" || st === "dedupe_check" || st === "db_inserting" || st === "downloaded")
    return "warning";
  if (st === "reused") return "success";
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
  if (!total || total <= 0) {
    return `${formatBytes(p.receivedBytes)} / ?`;
  }
  return `${formatBytes(p.receivedBytes)} / ${formatBytes(total)}`;
};

const loadDownloads = async () => {
  try {
    const [downloads, size] = await Promise.all([
      invoke<ActiveDownloadInfo[]>("get_active_downloads"),
      invoke<number>("get_download_queue_size"),
    ]);
    activeDownloads.value = downloads;
    queueSize.value = size;

    // 清理已不在 active 列表里的进度，避免内存增长
    const aliveKeys = new Set(downloads.map(downloadKey));
    const next: Record<string, DownloadProgressState> = {};
    for (const [k, v] of Object.entries(downloadProgressByKey.value)) {
      if (aliveKeys.has(k)) next[k] = v;
    }
    downloadProgressByKey.value = next;

    const nextState: Record<string, { state: string; error?: string; updatedAt: number }> = {};
    for (const [k, v] of Object.entries(downloadStateByKey.value)) {
      if (aliveKeys.has(k)) nextState[k] = v;
    }
    downloadStateByKey.value = nextState;
  } catch (error) {
    console.error("加载下载列表失败:", error);
  }
};

const handleClearDownloadQueue = async () => {
  if (queueSize.value === 0) return;
  try {
    await ElMessageBox.confirm(
      `确定要清空等待队列吗？将移除队列中 ${queueSize.value} 个待下载任务（不影响正在下载）。`,
      "终止队列",
      { type: "warning" }
    );
    const removed = await invoke<number>("clear_download_queue");
    ElMessage.success(`已清空队列（移除 ${removed} 个任务）`);
    await loadDownloads();
  } catch (error) {
    if (error !== "cancel") {
      console.error("清空队列失败:", error);
      ElMessage.error("清空队列失败");
    }
  }
};

const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

const formatDate = (timestamp: number) => {
  // 兼容秒/毫秒时间戳：大于 1e12 视为毫秒，否则视为秒
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
  };
  return map[status] || "info";
};

const getStatusText = (status: string) => {
  const map: Record<string, string> = {
    pending: "等待中",
    running: "运行中",
    completed: "完成",
    failed: "失败",
  };
  return map[status] || status;
};

const ensurePluginVars = async (pluginId: string) => {
  if (pluginVarMetaMap.value[pluginId]) return;
  try {
    const vars = await invoke<Array<{ key: string; name: string; type?: string; options?: VarOption[] }> | null>("get_plugin_vars", { pluginId });
    const metaMap: Record<string, PluginVarMeta> = {};
    (vars || []).forEach((v) => {
      const display = v.name || v.key;
      const optionNameByVariable: Record<string, string> = {};
      (v.options || []).forEach((opt) => {
        if (typeof opt === "string") {
          optionNameByVariable[opt] = opt;
        } else {
          optionNameByVariable[opt.variable] = opt.name;
        }
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

const getVarDisplayName = (pluginId: string, key: string) => {
  return pluginVarMetaMap.value[pluginId]?.[key]?.name || key;
};

const formatConfigValue = (pluginId: string, key: string, value: any): string => {
  const meta = pluginVarMetaMap.value[pluginId]?.[key];
  const map = meta?.optionNameByVariable || {};
  if (value === null || value === undefined) {
    return '未设置';
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (Array.isArray(value)) {
    // list/checkbox: ['a','b'] -> 按 variable 映射 name
    return value.map((v) => (typeof v === "string" ? (map[v] || v) : String(v))).join(', ');
  }
  if (typeof value === 'object') {
    // checkbox 等场景：{ a: true, b: false } -> "a"
    const entries = Object.entries(value as Record<string, any>);
    if (entries.length > 0 && entries.every(([, v]) => typeof v === 'boolean')) {
      const selected = entries.filter(([, v]) => v === true).map(([k]) => k);
      const named = selected.map((v) => map[v] || v);
      return named.length > 0 ? named.join(', ') : '未选择';
    }
    return JSON.stringify(value, null, 2);
  }
  // options: "high" -> 显示 name
  const s = String(value);
  return map[s] || s;
};

const handleOpenImagePath = async (localPath: string) => {
  try {
    await invoke("open_file_path", { filePath: localPath });
  } catch (error) {
    console.error("打开文件失败:", error);
    ElMessage.error("打开文件失败");
  }
};

// ========== 任务文件浏览 ==========
const resetViewerState = () => {
  viewerTaskId.value = "";
  viewerTaskName.value = "";
  viewerImages.value = [];
  viewerImageUrls.value = {};
  viewerPage.value = 0;
  viewerHasMore.value = false;
  viewerLoading.value = false;
  viewerLoadingMore.value = false;
  viewerBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  viewerBlobUrls.clear();
};

const getImageBlobUrl = async (path: string): Promise<string> => {
  if (!path) return "";
  try {
    const normalizedPath = path.trimStart().replace(/^\\\\\?\\/, "");
    const data = await readFile(normalizedPath);
    const ext = normalizedPath.split(".").pop()?.toLowerCase();
    let mime = "image/jpeg";
    if (ext === "png") mime = "image/png";
    else if (ext === "gif") mime = "image/gif";
    else if (ext === "webp") mime = "image/webp";
    else if (ext === "bmp") mime = "image/bmp";
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    viewerBlobUrls.add(url);
    return url;
  } catch (error) {
    console.error("读取图片失败", path, error);
    return "";
  }
};

const fillViewerUrls = async (images: ImageInfo[]) => {
  const updates: Record<string, { thumbnail?: string; original?: string }> = {};
  for (const img of images) {
    const thumb = img.thumbnailPath ? await getImageBlobUrl(img.thumbnailPath) : "";
    const orig = await getImageBlobUrl(img.localPath);
    updates[img.id] = {
      thumbnail: thumb || orig || undefined,
      original: orig || undefined,
    };
  }
  viewerImageUrls.value = { ...viewerImageUrls.value, ...updates };
};

const loadViewerPage = async (reset = false) => {
  if (!viewerTaskId.value) return;
  if (reset) {
    viewerImages.value = [];
    viewerImageUrls.value = {};
    viewerPage.value = 0;
    viewerHasMore.value = false;
  }

  const page = reset ? 0 : viewerPage.value;
  const setter = reset ? viewerLoading : viewerLoadingMore;
  setter.value = true;
  try {
    const result = await crawlerStore.getTaskImagesPaginated(
      viewerTaskId.value,
      page,
      VIEWER_PAGE_SIZE
    );
    const newList = reset ? result.images : [...viewerImages.value, ...result.images];
    viewerImages.value = newList;
    viewerHasMore.value = (page + 1) * VIEWER_PAGE_SIZE < result.total;
    viewerPage.value = page + 1;
    await fillViewerUrls(result.images);
  } catch (error) {
    console.error("加载任务文件失败:", error);
    ElMessage.error("加载失败");
  } finally {
    setter.value = false;
  }
};

const openTaskImages = async (task: any) => {
  resetViewerState();
  viewerTaskId.value = task.id;
  viewerTaskName.value = getPluginName(task.pluginId);
  taskViewerVisible.value = true;
  await loadViewerPage(true);
};

const handleViewerClose = () => {
  taskViewerVisible.value = false;
  resetViewerState();
};

const handleSaveViewerToAlbum = async () => {
  if (viewerImages.value.length === 0) return;
  // 若未加载完全，提示用户当前只会保存已加载部分
  if (viewerHasMore.value) {
    try {
      await ElMessageBox.confirm(
        `当前仅已加载 ${viewerImages.value.length} 张图片，仍有未加载内容。是否只将已加载部分保存到画册？`,
        "保存为画册",
        { type: "warning" }
      );
    } catch {
      return;
    }
  }
  addToAlbumVisible.value = true;
};

const handleViewerImageClick = (image: ImageInfo) => {
  viewerSelected.value = new Set([image.id]);
};

const handleViewerImageDblClick = async (image: ImageInfo) => {
  await handleOpenImagePath(image.localPath);
};

onUnmounted(() => {
  resetViewerState();
});

// 右键菜单
const openTaskContextMenu = (event: MouseEvent, task: any) => {
  event.preventDefault();
  contextMenuTask.value = task;
  contextMenuVisible.value = true;
  contextMenuPos.value = { x: event.clientX, y: event.clientY };
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuTask.value = null;
};

const handleContextAction = async (action: string) => {
  const task = contextMenuTask.value;
  closeContextMenu();
  if (!task) return;
  switch (action) {
    case "view":
      await openTaskImages(task);
      break;
    case "delete":
      await handleDeleteTask(task);
      break;
    case "save-config":
      openSaveConfigDialog(task);
      break;
  }
};

const resetSaveConfigForm = () => {
  savingConfig.value = false;
  saveConfigTask.value = null;
  saveConfigName.value = "";
  saveConfigDescription.value = "";
};

const openSaveConfigDialog = (task: any) => {
  const pluginName = getPluginName(task.pluginId);
  saveConfigTask.value = task;
  saveConfigName.value = pluginName;
  saveConfigDescription.value = "";
  saveConfigVisible.value = true;
};

const confirmSaveTaskAsConfig = async () => {
  const task = saveConfigTask.value;
  if (!task) return;
  const name = saveConfigName.value.trim();
  if (!name) {
    ElMessage.warning("请输入配置名称");
    return;
  }
  savingConfig.value = true;
  try {
    await crawlerStore.addRunConfig({
      name,
      description: saveConfigDescription.value.trim() || undefined,
      pluginId: task.pluginId,
      url: task.url,
      outputDir: task.outputDir,
      userConfig: task.userConfig ?? {},
    });
    ElMessage.success("已保存为配置");
    saveConfigVisible.value = false;
    resetSaveConfigForm();
  } catch (error) {
    console.error("保存为配置失败:", error);
    ElMessage.error("保存失败");
  } finally {
    savingConfig.value = false;
  }
};

const handleGlobalClick = () => {
  if (contextMenuVisible.value) {
    closeContextMenu();
  }
};

// 是否已初始化事件监听
let eventListenersInitialized = false;

const initEventListeners = async () => {
  if (eventListenersInitialized) return;
  eventListenersInitialized = true;

  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlistenDownloadProgress = await listen<DownloadProgressPayload>(
      "download-progress",
      (event) => {
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
      }
    );
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

const handleDrawerOpen = async () => {
  // drawer 打开时才开始加载数据和初始化事件监听
  await initEventListeners();
  loadDownloads();
  // 开启定时刷新
  if (downloadRefreshInterval === null) {
    downloadRefreshInterval = window.setInterval(loadDownloads, 1000);
  }
};

onMounted(() => {
  window.addEventListener("click", handleGlobalClick);
});

// 当 drawer 关闭时，停止定时刷新（节省资源）
watch(visible, (val) => {
  if (!val && downloadRefreshInterval !== null) {
    clearInterval(downloadRefreshInterval);
    downloadRefreshInterval = null;
  }
});

onUnmounted(() => {
  window.removeEventListener("click", handleGlobalClick);
  if (downloadRefreshInterval !== null) {
    clearInterval(downloadRefreshInterval);
  }
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

const toggleTaskExpand = async (taskId: string) => {
  if (expandedTasks.value.has(taskId)) {
    expandedTasks.value.delete(taskId);
    return;
  }
  const task = props.tasks.find((t) => t.id === taskId);
  if (task) {
    await ensurePluginVars(task.pluginId);
  }
  expandedTasks.value.add(taskId);
};

const handleStopTask = async (task: any) => {
  try {
    await ElMessageBox.confirm(
      "确定要停止这个任务吗？已下载的图片将保留，未开始的任务将取消。",
      "停止任务",
      { type: "warning" }
    );
    await crawlerStore.stopTask(task.id);
    ElMessage.success("任务已请求停止");
  } catch (error) {
    if (error !== "cancel") {
      console.error("停止任务失败:", error);
      ElMessage.error("停止任务失败");
    }
  }
};

const handleDeleteTask = async (task: any) => {
  try {
    const needStop = task.status === "running";
    const msg = needStop
      ? "当前任务正在运行，删除前将先终止任务。确定继续吗？"
      : "确定要删除这个任务吗？";
    await ElMessageBox.confirm(msg, "确认删除", { type: "warning" });

    if (needStop) {
      try {
        await crawlerStore.stopTask(task.id);
      } catch (err) {
        console.error("终止任务失败，已取消删除", err);
        ElMessage.error("终止任务失败，删除已取消");
        return;
      }
    }

    await crawlerStore.deleteTask(task.id);
    expandedTasks.value.delete(task.id);
    ElMessage.success("任务已删除");
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error("删除失败");
    }
  }
};

const handleDeleteCompletedTasks = async () => {
  const completed = props.tasks.filter((t) => t.status === "completed");
  if (completed.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `确定要删除所有已完成任务吗？共 ${completed.length} 个。`,
      "清理已完成任务",
      { type: "warning" }
    );
    for (const t of completed) {
      // 只删除完成任务，不触碰 running/failed
      await crawlerStore.deleteTask(t.id);
      expandedTasks.value.delete(t.id);
    }
    ElMessage.success("已清理完成任务");
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error("清理失败");
    }
  }
};

const handleCopyError = async (task: any) => {
  let text = "=== 任务错误信息 ===\n";
  text += `错误：${task.error || '执行失败'}\n\n`;

  text += "=== 运行参数 ===\n";
  text += `源：${getPluginName(task.pluginId)}\n`;
  if (task.url) {
    text += `URL：${task.url}\n`;
  }
  if (task.outputDir) {
    text += `输出目录：${task.outputDir}\n`;
  }
  if (task.userConfig && Object.keys(task.userConfig).length > 0) {
    text += `配置参数：\n`;
    for (const [key, value] of Object.entries(task.userConfig)) {
      text += `  ${key}：${formatConfigValue(task.pluginId, String(key), value)}\n`;
    }
  }
  if (task.startTime) {
    text += `开始时间：${formatDate(task.startTime)}\n`;
  }
  if (task.endTime) {
    text += `结束时间：${formatDate(task.endTime)}\n`;
  }
  text += `进度：${Math.round(task.progress)}%\n`;
  text += `已下载：${task.downloadedImages} / ${task.totalImages}`;

  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("已复制到剪贴板");
  } catch (error) {
    console.error("复制失败:", error);
    ElMessage.error("复制失败");
  }
};
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
                background: linear-gradient(90deg,
                    rgba(255, 255, 255, 0.15) 0%,
                    rgba(255, 255, 255, 0.85) 50%,
                    rgba(255, 255, 255, 0.15) 100%);
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

.task-images-dialog {
  .el-dialog__body {
    padding: 0 0 12px 0;
  }
}

.task-images-viewer {
  padding: 12px 16px 4px 16px;

  .viewer-loading,
  .viewer-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: center;
    color: var(--anime-text-secondary);
    min-height: 200px;
  }

  .viewer-empty .el-icon {
    font-size: 20px;
  }

  .viewer-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 12px;
  }

  .viewer-count {
    color: var(--anime-text-secondary);
    font-size: 12px;
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

<style lang="scss">
/* 图片路径 tooltip 样式 */
.image-path-tooltip {
  max-width: 400px;
  padding: 8px 12px;
}

.task-images-dialog.el-dialog {
  max-height: 90vh !important;
  display: flex !important;
  flex-direction: column !important;
  margin-top: 5vh !important;
  margin-bottom: 5vh !important;
  overflow: hidden !important;

  .el-dialog__header {
    flex-shrink: 0 !important;
  }

  .el-dialog__body {
    flex: 1 1 auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    min-height: 0 !important;
  }

  .el-dialog__footer {
    flex-shrink: 0 !important;
  }
}

.tooltip-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.4;
}

.tooltip-line {
  word-break: break-all;
  font-size: 12px;
}

/* 防止 drawer 遮罩闪烁 */
.task-drawer-modal {
  /* 确保遮罩层有稳定的初始状态，避免闪烁 */
  will-change: opacity;
  backface-visibility: hidden;
}
</style>
