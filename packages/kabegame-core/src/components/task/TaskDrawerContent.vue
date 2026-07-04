<template>
  <div class="tasks-drawer-content">
    <div class="drawer-accordion">
      <CollapsibleDrawerPanel storage-key="kabegame-task-drawer-downloads-open">
        <template #title>
          <span class="drawer-panel-title">{{ t("tasks.drawerDownloading") }}</span>
        </template>
        <template #trailing>
          <el-tag type="warning" size="small">{{ activeDownloadsRunningCount }}</el-tag>
        </template>
        <div class="drawer-panel-body drawer-panel-body--downloads">
          <div class="downloads-section">
            <div v-if="orderedActiveDownloads.length === 0" class="downloads-empty">
              <el-empty :description="t('tasks.drawerNoDownloads')" :image-size="60" />
            </div>
            <div v-else class="downloads-content">
              <div class="downloads-list">
                <transition-group name="download-fade" tag="div" class="downloads-list-inner">
                  <div v-for="download in orderedActiveDownloads" :key="downloadKey(download)" class="download-item">
                    <div class="download-info">
                      <div class="download-url" :title="download.url">{{ download.url }}</div>
                      <div class="download-meta">
                        <el-tag size="small" type="info">{{ getPluginName(download.pluginId) }}</el-tag>
                        <el-tag size="small" :type="downloadStateTagType(download)">
                          {{ downloadStateText(download) }}
                        </el-tag>
                      </div>
                      <div v-if="shouldShowDownloadProgress(download) && downloadProgressText(download)"
                        class="download-progress">
                        <el-progress :percentage="downloadProgressPercent(download)"
                          :format="() => downloadProgressText(download)!" :stroke-width="10" />
                      </div>
                    </div>
                  </div>
                </transition-group>
              </div>
            </div>
          </div>
        </div>
      </CollapsibleDrawerPanel>

      <CollapsibleDrawerPanel storage-key="kabegame-task-drawer-tasks-open" class="drawer-panel--tasks">
        <template #title>
          <span class="drawer-panel-title">{{ t("tasks.taskList") }}</span>
        </template>
        <template #trailing>
          <el-tag type="info" size="small">{{ displayTaskCount }}</el-tag>
        </template>
        <div class="drawer-panel-body drawer-panel-body--tasks">
          <div class="tasks-summary">
            <span>{{ t('tasks.drawerTaskCount', { n: displayTaskCount }) }}</span>
            <el-button text size="small" class="clear-completed-btn" :disabled="nonRunningTasksCount === 0"
              @click.stop="$emit('clear-finished-tasks')">
              {{ t('tasks.drawerClearAll', { n: nonRunningTasksCount }) }}
            </el-button>
          </div>
          <div class="tasks-list-col">
            <div class="tasks-list tasks-list--virtual" v-bind="containerProps" @scroll="handleTasksListScroll">
              <div v-bind="wrapperProps">
                <div v-for="item in virtualList" :key="item.data.id" class="task-drawer-virtual-item">
                  <div class="task-item task-item--fixed" :class="{ 'task-item-failed': item.data.status === 'failed' }"
                    @contextmenu="(e) => handleTaskContextMenu(e, item.data)">
                    <div class="task-close">
                      <el-button text circle size="small" class="close-btn" :title="t('tasks.drawerDeleteTask')"
                        @click="$emit('delete-task', item.data.id)">
                        <el-icon>
                          <Close />
                        </el-icon>
                      </el-button>
                    </div>
                    <div class="task-item-body task-item-body--drawer">
                      <div class="task-drawer-grid-icon" aria-hidden="true">
                        <div class="task-drawer-plugin-icon-box">
                          <el-image v-if="drawerPluginIconSrc(item.data.pluginId)"
                            :src="String(drawerPluginIconSrc(item.data.pluginId))" fit="contain"
                            class="task-drawer-plugin-img" />
                          <el-icon v-else class="task-drawer-plugin-fallback">
                            <Grid />
                          </el-icon>
                        </div>
                      </div>
                      <div class="task-drawer-grid-summary">
                        <TaskSummaryRow :task="item.data" layout="stacked"
                          :show-schedule-button="isScheduledTask(item.data)"
                          :scheduled-task-aria-label="scheduledTaskAriaLabel(item.data)" show-status-tag
                          stacked-omit-image-log-actions @open-task-images="(id) => $emit('open-task-images', id)"
                          @open-task-log="openTaskLog($event)"
                          @open-schedule-config="handleOpenTaskScheduleConfig($event)" />
                      </div>
                      <div class="task-drawer-grid-footer">
                        <div class="task-drawer-footer-progress-slot">
                          <div v-if="shouldShowTaskProgressBar(item.data)" class="task-drawer-running-block">
                            <div class="task-progress task-progress--compact" :class="{
                              'task-progress--canceled-bar': isCanceledTaskStatus(item.data.status),
                              'task-progress--failed-bar': item.data.status === 'failed',
                            }">
                              <el-progress :percentage="taskProgressPercent(item.data)" :stroke-width="4"
                                :color="taskProgressBarColor(item.data.status)"
                                :show-text="item.data.status === 'running'" />
                              <div v-if="item.data.status === 'running'" class="progress-footer">
                                <el-button text size="small" type="warning" class="stop-btn"
                                  @click.stop="$emit('cancel-task', item.data.id)">
                                  {{ t("tasks.drawerStop") }}
                                </el-button>
                              </div>
                            </div>
                          </div>
                        </div>
                        <div class="task-drawer-footer-actions">
                          <div class="task-drawer-action-btns">
                            <el-button plain size="small" type="info" class="task-drawer-action-btn"
                              :title="t('tasks.openRunParams')" @click.stop="openRunParamsDialog(item.data)">
                              {{ t("tasks.drawerTaskActionParams") }}
                            </el-button>
                            <el-button plain size="small" type="success" class="task-drawer-action-btn"
                              :title="t('tasks.drawerViewImages')"
                              @click.stop="$emit('open-task-images', item.data.id)">
                              {{ t("tasks.drawerTaskActionImages") }}
                            </el-button>
                            <el-button plain size="small" type="warning" class="task-drawer-action-btn"
                              :title="t('tasks.drawerViewLog')" @click.stop="openTaskLog(item.data.id)">
                              {{ t("tasks.drawerTaskActionLog") }}
                            </el-button>
                            <el-button v-if="shouldShowTaskWebviewButton(item.data)" plain size="small" type="primary"
                              class="task-drawer-action-btn" :title="t('tasks.openTaskWebview')"
                              @click.stop="openTaskWindow(item.data.id)">
                              {{ t("tasks.drawerTaskActionWebview") }}
                            </el-button>
                          </div>
                          <div v-if="item.data.startTime != null && Number(item.data.startTime) > 0"
                            class="task-drawer-start-time" :title="formatDrawerTaskStartFull(item.data.startTime)">
                            {{ formatDrawerTaskStart(item.data.startTime) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="hasMore && loadingMore" class="load-more-indicator">
              <el-icon class="is-loading">
                <Loading />
              </el-icon>
              <span>{{ t("common.loading") }}</span>
            </div>
          </div>
        </div>
      </CollapsibleDrawerPanel>
    </div>

    <TaskParamsDialog :open="runParamsDialog.isOpen.value" :z-index="runParamsDialog.zIndex.value" :task="runParamsTask" @close="runParamsDialog.close()" @closed="runParamsTask = null" />
    <TaskLogDialog ref="taskLogDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useModal } from "../../composables/useModal";
import { useVirtualList } from "@vueuse/core";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { Close, Grid, Loading } from "@element-plus/icons-vue";
import { invoke, listen } from "../../api";
import CollapsibleDrawerPanel from "../common/CollapsibleDrawerPanel.vue";
import TaskLogDialog from "./TaskLogDialog.vue";
import TaskParamsDialog from "./TaskParamsDialog.vue";
import TaskSummaryRow, { type TaskSummaryRowTask } from "./TaskSummaryRow.vue";
import { useCrawlerStore } from "../../stores/crawler";
import { LOCAL_IMPORT_PLUGIN_ID, usePluginStore } from "../../stores/plugins";
import type { PluginManifestText } from "../../stores/plugins";
import type { TaskRunParamsTask } from "./TaskRunParamsContent.vue";
import { trackEvent } from "../../track/umami";
import { kameMessage as ElMessage } from "../../utils/kameMessage";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const crawlerStore = useCrawlerStore();

const TASK_PAGE_SIZE = 20;

type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  runConfigId?: string;
  triggerSource?: "manual" | "scheduled" | string;
  status: TaskStatus | string;
  progress: number;
  deletedCount?: number;
  dedupCount?: number;
  successCount?: number;
  failedCount?: number;
  outputDir?: string | null;
  userConfig?: Record<string, any> | null;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

type ActiveDownloadInfo = {
  id: number;
  url: string;
  pluginId: string;
  startTime: number;
  taskId: string;
  state?: string;
  native?: boolean;
};

type DownloadProgressPayload = {
  id: number;
  receivedBytes: number;
  totalBytes?: number | null;
};

type DownloadStatePayload = {
  id: number;
  taskId: string;
  url: string;
  startTime: number;
  pluginId: string;
  state: string;
  error?: string;
  native?: boolean;
};

const props = withDefaults(
  defineProps<{
    tasks: ScriptTask[];
    plugins?: Array<{ id: string; name?: PluginManifestText }>;
    /** active=false 时停止下载轮询与事件监听（main drawer 关闭时用） */
    active?: boolean;
    /** 可关闭右键菜单 */
    enableContextMenu?: boolean;
  }>(),
  { plugins: () => [], active: true, enableContextMenu: true }
);

const emit = defineEmits<{
  (e: "delete-task", taskId: string): void;
  (e: "cancel-task", taskId: string): void;
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-schedule-config", task: TaskSummaryRowTask): void;
  (e: "clear-finished-tasks"): void;
  (e: "task-contextmenu", payload: { x: number; y: number; task: ScriptTask }): void;
}>();

const nonRunningTasksCount = computed(
  () => props.tasks.filter((t) => t.status !== "running" && t.status !== "pending").length
);

/** 分页：已加载数 < 总数 则有更多 */
const hasMore = computed(
  () => crawlerStore.tasksTotal > 0 && crawlerStore.tasks.length < crawlerStore.tasksTotal
);
/** 任务数量展示：有总分页时显示总数，否则显示当前条数 */
const displayTaskCount = computed(() =>
  crawlerStore.tasksTotal > 0 ? crawlerStore.tasksTotal : props.tasks.length
);

const loadingMore = ref(false);

const kbAppPublicIcon = `${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/icon.png`;

function isCanceledTaskStatus(status: string): boolean {
  return status === "canceled" || status === "cancelled";
}

/** 与 CrawlTask 一致：running / failed / canceled 且 progress>0 时显示进度条（老任务 progress=0 不显示） */
function shouldShowTaskProgressBar(task: ScriptTask): boolean {
  const p = Number(task.progress ?? 0);
  if (!Number.isFinite(p) || p <= 0) return false;
  const s = task.status;
  return s === "running" || s === "failed" || isCanceledTaskStatus(s);
}

function taskProgressPercent(task: ScriptTask): number {
  const p = Number(task.progress ?? 0);
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(100, Math.max(0, p)));
}

/** failed：外层 .task-progress--failed-bar 强制红条；running：默认主色；canceled：.task-progress--canceled-bar 灰条 */
function taskProgressBarColor(status: string): string | undefined {
  if (status === "failed") return "var(--el-color-danger)";
  return undefined;
}

/** 抽屉任务行图标：本地导入用应用 public/icon.png，其余读 pluginStore 缓存 */
function drawerPluginIconSrc(pluginId: string): string | undefined {
  if (!pluginId) return undefined;
  if (pluginId === LOCAL_IMPORT_PLUGIN_ID) return kbAppPublicIcon;
  return pluginStore.pluginIconDataUrl(pluginId);
}

/** 与虚拟列表行高一致（须与 .task-drawer-virtual-item height 相同） */
const TASK_DRAWER_ITEM_HEIGHT = 166;

const tasksSource = computed(() => props.tasks);
const { list: virtualList, containerProps, wrapperProps } = useVirtualList(tasksSource, {
  itemHeight: TASK_DRAWER_ITEM_HEIGHT,
  overscan: 6,
});

const runParamsDialog = useModal();
const runParamsTask = ref<TaskRunParamsTask | null>(null);

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function currentPagePath() {
  return typeof location === "undefined" ? "" : location.pathname;
}

function trackTaskDrawerAction(action: "view_params" | "view_log" | "open_webview", task: ScriptTask) {
  trackEvent("task_drawer_task_action", {
    action,
    taskId: task.id,
    pluginId: task.pluginId,
    status: task.status,
    triggerPage: currentPagePath(),
    url: currentUrl(),
  });
}

function openRunParamsDialog(task: ScriptTask) {
  trackTaskDrawerAction("view_params", task);
  runParamsTask.value = task;
  runParamsDialog.open();
}

async function loadMoreTasks() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    await crawlerStore.loadTasksPage(TASK_PAGE_SIZE, crawlerStore.tasks.length);
  } finally {
    loadingMore.value = false;
  }
}

function handleTasksListScroll(e: Event) {
  const el = e.target as HTMLElement | null;
  if (!el || loadingMore.value || !hasMore.value) return;
  const { scrollTop, clientHeight, scrollHeight } = el;
  const threshold = 60;
  if (scrollTop + clientHeight >= scrollHeight - threshold) {
    void loadMoreTasks();
  }
}

// 下载信息：单一 map，download-state 到达 upsert，download-removed 到达删除
type DownloadItem = ActiveDownloadInfo & { received?: number; total?: number | null };
const downloadsMap = reactive<Record<number, DownloadItem>>({});

const allDownloads = computed(() => Object.values(downloadsMap) as DownloadItem[]);
const activeDownloadsRunningCount = computed(() =>
  allDownloads.value.filter((d) => {
    const st = d.state ?? "";
    return st !== "completed" && st !== "failed" && st !== "canceled";
  }).length
);
const orderedActiveDownloads = computed(() => [
  ...allDownloads.value.filter((d) => !d.native),
  ...allDownloads.value.filter((d) => !!d.native),
]);

let unlistenDownloadProgress: null | (() => void) = null;
let unlistenDownloadState: null | (() => void) = null;
let unlistenDownloadRemoved: null | (() => void) = null;

const taskLogDialogRef = ref<InstanceType<typeof TaskLogDialog> | null>(null);

const downloadKey = (d: ActiveDownloadInfo) => String(d.id);

const downloadStateText = (d: DownloadItem) => {
  const keyMap: Record<string, string> = {
    preparing: "tasks.drawerStatusPreparing",
    downloading: "tasks.drawerStatusDownloading",
    extracting: "tasks.drawerStatusExtracting",
    processing: "tasks.drawerStatusProcessing",
    completed: "tasks.drawerStatusCompleted",
    failed: "tasks.drawerStatusFailed",
    canceled: "tasks.drawerStatusCanceled",
  };
  const st = d.state ?? "downloading";
  return keyMap[st] ? t(keyMap[st]) : st;
};

const downloadStateTagType = (d: DownloadItem) => {
  const st = d.state ?? "";
  if (st === "failed") return "danger";
  if (st === "canceled" || st === "preparing") return "info";
  if (st === "completed" || st === "processing") return "success";
  if (st === "extracting" || st === "downloading") return "warning";
  return "info";
};

const formatBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const fixed = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(fixed)} ${units[i]}`;
};

const shouldShowDownloadProgress = (d: DownloadItem) => (d.state ?? "") === "downloading";

const downloadProgressPercent = (d: DownloadItem) => {
  const total = d.total ?? null;
  if (!total || total <= 0 || d.received == null) return 0;
  return Math.max(0, Math.min(100, Math.floor((d.received / total) * 100)));
};

const downloadProgressText = (d: DownloadItem) => {
  if (d.received == null) return null;
  const total = d.total ?? null;
  if (!total || total <= 0) return `${formatBytes(d.received)} / ?`;
  return `${formatBytes(d.received)} / ${formatBytes(total)}`;
};

const loadDownloads = async () => {
  try {
    const downloads = await invoke<ActiveDownloadInfo[]>("get_active_downloads");
    const aliveIds = new Set(downloads.map((d) => d.id));
    for (const id of (Object.keys(downloadsMap) as unknown as number[])) {
      if (!aliveIds.has(Number(id))) delete downloadsMap[id];
    }
    for (const d of downloads) {
      downloadsMap[d.id] = {
        ...downloadsMap[d.id],
        id: d.id, url: d.url, pluginId: d.pluginId,
        startTime: d.startTime, taskId: d.taskId,
        state: d.state ?? "downloading", native: d.native,
      };
    }
  } catch (error) {
    console.error("加载下载列表失败:", error);
  }
};

let eventListenersInitialized = false;

/** 渐进式事件，挂载时统一监听，不依赖抽屉开关，避免丢失信息 */
const initAllEventListeners = async () => {
  if (eventListenersInitialized) return;
  eventListenersInitialized = true;

  const toId = (raw: any) => { const id = Number(raw?.id); return isNaN(id) ? null : id; };

  try {
    unlistenDownloadProgress = await listen<DownloadProgressPayload>("download-progress", (event) => {
      const raw = event.payload as any;
      const id = toId(raw);
      if (id == null || !downloadsMap[id]) return;
      downloadsMap[id] = {
        ...downloadsMap[id],
        received: Number(raw.receivedBytes ?? 0),
        total: raw.totalBytes ?? null,
      };
    });
  } catch (error) {
    console.error("监听下载进度失败:", error);
  }
  try {
    unlistenDownloadState = await listen<DownloadStatePayload>("download-state", (event) => {
      const raw = event.payload as any;
      const id = toId(raw);
      if (id == null) return;
      const state = String(raw?.state ?? "").trim();
      if (!state) return;
      downloadsMap[id] = {
        ...downloadsMap[id],
        id,
        url: String(raw.url ?? ""),
        pluginId: String(raw.pluginId ?? ""),
        startTime: Number(raw.startTime ?? 0),
        taskId: String(raw.taskId ?? ""),
        state,
        native: !!raw.native,
      };
    });
  } catch (error) {
    console.error("监听下载状态失败:", error);
  }
  try {
    unlistenDownloadRemoved = await listen<{ id: number; taskId?: string }>("download-removed", (event) => {
      const id = toId(event.payload as any);
      if (id != null) delete downloadsMap[id];
    });
  } catch (error) {
    console.error("监听下载移除失败:", error);
  }
};

const stopAllEventListeners = () => {
  unlistenDownloadProgress?.();
  unlistenDownloadState?.();
  unlistenDownloadRemoved?.();
  unlistenDownloadProgress = null;
  unlistenDownloadState = null;
  unlistenDownloadRemoved = null;
  eventListenersInitialized = false;
};

/** 抽屉打开时同步一次快照，纠正可能错过的事件 */
const syncDownloadsOnDrawerOpen = async () => {
  await loadDownloads();
};

const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);
const isScheduledTask = (task: ScriptTask) => task.triggerSource === "scheduled";

const isJsTask = (pluginId: string) =>
  pluginStore.plugins.find((plugin) => plugin.id === pluginId)?.scriptType === "js";

const shouldShowTaskWebviewButton = (task: ScriptTask) =>
  task.status === "running" && isJsTask(task.pluginId);

async function openTaskWindow(taskId: string) {
  const id = String(taskId || "").trim();
  if (!id) return;
  const task = props.tasks.find((t) => t.id === id);
  if (task) trackTaskDrawerAction("open_webview", task);
  try {
    await invoke("show_crawler_window", { taskId: id });
    ElMessage.success(t("tasks.openTaskWebviewSuccess"));
  } catch (error) {
    ElMessage.error(String(error));
  }
}

const getRunConfigName = (task: ScriptTask) => {
  const runConfigId = `${task.runConfigId ?? ""}`.trim();
  if (!runConfigId) return "-";
  const cfg = crawlerStore.runConfigById(runConfigId);
  if (!cfg) return runConfigId;
  return resolveConfigText(cfg.name as any, locale.value) || runConfigId;
};

const scheduledTaskAriaLabel = (task: ScriptTask) =>
  t("tasks.scheduledTaskAriaLabel", { configName: getRunConfigName(task) });

const handleOpenTaskScheduleConfig = (task: TaskSummaryRowTask) => {
  emit("open-task-schedule-config", task);
};

const openTaskLog = async (taskId: string) => {
  const id = String(taskId || "").trim();
  if (!id) return;
  const task = props.tasks.find((t) => t.id === id);
  if (task) trackTaskDrawerAction("view_log", task);
  await taskLogDialogRef.value?.openTaskLog(id);
};

const toLocaleTagDrawer = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

/** 抽屉条目右下角：短开始时间 */
function formatDrawerTaskStart(startTime: number | null | undefined): string {
  if (startTime == null || startTime === 0) return "";
  const ms = startTime > 1e12 ? startTime : startTime * 1000;
  const tag = toLocaleTagDrawer(locale.value ?? "zh");
  return new Date(ms).toLocaleString(tag, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDrawerTaskStartFull(startTime: number | null | undefined): string {
  if (startTime == null || startTime === 0) return "";
  const ms = startTime > 1e12 ? startTime : startTime * 1000;
  const tag = toLocaleTagDrawer(locale.value ?? "zh");
  return new Date(ms).toLocaleString(tag);
}

function handleTaskContextMenu(event: MouseEvent, task: ScriptTask) {
  event.preventDefault();
  if (!props.enableContextMenu) return;
  emit("task-contextmenu", { x: event.clientX, y: event.clientY, task });
}

onMounted(() => {
  initAllEventListeners();
});

watch(
  () => !!props.active,
  async (val) => {
    if (val) await syncDownloadsOnDrawerOpen();
  },
  { immediate: true }
);

onUnmounted(() => {
  stopAllEventListeners();
});
</script>

<style scoped lang="scss">
.tasks-drawer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow-x: hidden;

  .drawer-accordion {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px 10px;
  }

  .drawer-panel-title {
    font-size: 14px;
    font-weight: 600;
  }

  .drawer-panel-body--downloads,
  .drawer-panel-body--tasks {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .downloads-section {
    flex: 1;
    min-height: 0;
    padding: 0 12px 12px;
    display: flex;
    flex-direction: column;

    .downloads-empty {
      padding: 20px 0;
    }

    .downloads-content {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;

      .downloads-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        margin-bottom: 12px;

        .downloads-list-inner {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

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

    .downloads-substatus {
      flex-shrink: 0;
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--anime-text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  /* 下载条目进入/退出动画（completed 0.2s 展示 + 列表更新） */
  .download-fade-enter-active,
  .download-fade-leave-active {
    transition: all 0.2s ease;
  }

  .download-fade-enter-from,
  .download-fade-leave-to {
    opacity: 0;
    transform: translateY(6px);
  }

  .download-fade-move {
    transition: transform 0.2s ease;
  }

  .tasks-summary {
    padding: 10px 12px;
    border-bottom: 1px solid var(--anime-border);
    font-size: 13px;
    color: var(--anime-text-secondary);
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tasks-list-col {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 10px 12px 12px;
  }

  .tasks-list--virtual {
    flex: 1;
    min-height: 0;
    min-width: 0;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .task-drawer-virtual-item {
    box-sizing: border-box;
    height: 166px;
    max-width: 100%;
    min-width: 0;
    padding: 0 4px 10px;
  }

  .load-more-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 0 0;
    font-size: 13px;
    color: var(--anime-text-secondary);
    flex-shrink: 0;
  }

  .task-item.task-item--fixed {
    box-sizing: border-box;
    height: 100%;
    max-width: 100%;
    min-width: 0;
    padding: 10px 32px 8px 14px;
    overflow: hidden;
    background: var(--anime-bg-card);
    border-radius: 8px;
    border: 1px solid var(--anime-border);
    position: relative;
    transition: background-color 0.2s ease, border-color 0.2s ease;

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
  }

  .task-item-body {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .task-item-body.task-item-body--drawer {
    --task-drawer-progress-slot-h: 36px;
    display: grid;
    grid-template-columns: 52px minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    gap: 2px 10px;
    align-items: start;
  }

  .task-drawer-grid-icon {
    grid-column: 1;
    grid-row: 1;
    align-self: start;
    padding-top: 2px;
  }

  .task-drawer-plugin-icon-box {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--el-fill-color-light, var(--anime-bg-secondary));
    border: 1px solid var(--el-border-color-lighter, var(--anime-border));
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .task-drawer-plugin-img {
    width: 100%;
    height: 100%;
  }

  .task-drawer-plugin-fallback {
    font-size: 20px;
    color: var(--el-text-color-secondary, var(--anime-text-muted));
  }

  .task-drawer-grid-summary {
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
  }

  /* 纵向 grid：顶行 1fr 占位；中间固定高度进度槽（无进度时也占高）；底行按钮 */
  .task-drawer-grid-footer {
    grid-column: 1 / -1;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr) var(--task-drawer-progress-slot-h) auto;
    row-gap: 4px;
    padding-top: 0;
  }

  .task-drawer-footer-progress-slot {
    grid-row: 2;
    min-width: 0;
    min-height: var(--task-drawer-progress-slot-h);
    max-height: var(--task-drawer-progress-slot-h);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: stretch;
    box-sizing: border-box;
    overflow: hidden;

    :deep(.el-progress--line) {
      margin: 0;
    }

    :deep(.el-progress-bar__outer) {
      margin: 0;
    }
  }

  .task-drawer-running-block {
    flex-shrink: 0;
    min-width: 0;
    width: 100%;
  }

  .task-drawer-footer-actions {
    grid-row: 3;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
    row-gap: 4px;
    overflow: hidden;
  }

  .task-drawer-action-btns {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
    flex: 1 1 0;
  }

  .task-drawer-action-btn {
    margin: 0;
    padding: 2px 6px;
    height: auto;
    min-height: 22px;
    font-size: 11px;
    line-height: 1.2;
    flex-shrink: 1;
  }

  .task-drawer-footer-actions .task-drawer-start-time {
    flex: 0 1 auto;
    margin: 0;
    max-width: 100%;
    min-width: 0;
    text-align: right;
  }

  :deep(.task-summary-row--stacked) {
    margin-bottom: 2px;
  }

  :deep(.task-summary-actions--stacked) {
    gap: 4px;
  }

  .task-drawer-start-time {
    font-size: 11px;
    line-height: 1.2;
    color: var(--anime-text-muted, var(--el-text-color-secondary));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-drawer-footer-progress-slot .task-progress--compact {
    flex-shrink: 0;
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    justify-content: center;

    &.task-progress--failed-bar {
      :deep(.el-progress-bar__inner) {
        background-color: var(--el-color-danger, #f56c6c) !important;
        background-image: none !important;
      }
    }

    &.task-progress--canceled-bar {
      :deep(.el-progress-bar__outer) {
        background-color: var(--el-fill-color-light, #e4e7ed) !important;
      }

      :deep(.el-progress-bar__inner) {
        background-color: var(--el-color-info, #909399) !important;
        background-image: none !important;
      }
    }

    .progress-footer {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      margin-top: 0;
      min-height: 18px;

      .stop-btn {
        padding: 0 2px;
        height: auto;
        font-size: 11px;
      }
    }
  }

  .task-close {
    position: absolute;
    top: 2px;
    right: 2px;
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
      }
    }
  }
}
</style>
