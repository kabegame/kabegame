<template>
  <div class="flex h-full min-w-0 flex-col overflow-x-hidden">
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-2.5 pb-2.5 pt-2">
      <CollapsibleDrawerPanel storage-key="kabegame-task-drawer-downloads-open">
        <template #title>{{ t("tasks.drawerDownloading") }}</template>
        <template #trailing>
          <Tag size="sm" :tone="activeDownloadsRunningCount > 0 ? 'accent' : 'neutral'">
            {{ activeDownloadsRunningCount }}
          </Tag>
        </template>
        <div class="flex min-h-0 flex-1 flex-col px-3 pb-3">
          <Empty v-if="orderedActiveDownloads.length === 0" :description="t('tasks.drawerNoDownloads')">
            <template #icon><Download /></template>
          </Empty>
          <div v-else class="min-h-0 flex-1 overflow-y-auto">
            <transition-group name="download-fade" tag="div" class="flex flex-col gap-2">
              <div
                v-for="download in orderedActiveDownloads"
                :key="downloadKey(download)"
                class="box-border flex min-w-0 flex-col gap-1.5 rounded-kb-md border border-solid border-kb-line bg-kb-surface-raised px-3 py-2"
              >
                <div class="truncate text-[12px] text-kb-fg" :title="download.url">{{ download.url }}</div>
                <div class="flex min-w-0 items-center gap-2">
                  <Tag size="sm">{{ getPluginName(download.pluginId) }}</Tag>
                  <Tag size="sm" :tone="downloadStateTone(download)">{{ downloadStateText(download) }}</Tag>
                </div>
                <div
                  v-if="shouldShowDownloadProgress(download) && downloadProgressText(download)"
                  class="mt-0.5 flex items-center gap-2"
                >
                  <Progress :value="downloadProgressPercent(download)" :height="6" />
                  <span class="shrink-0 text-[11px] tabular-nums text-kb-fg-muted">
                    {{ downloadProgressText(download) }}
                  </span>
                </div>
              </div>
            </transition-group>
          </div>
        </div>
      </CollapsibleDrawerPanel>

      <CollapsibleDrawerPanel storage-key="kabegame-task-drawer-tasks-open">
        <template #title>{{ t("tasks.taskList") }}</template>
        <template #trailing>
          <Tag size="sm">{{ displayTaskCount }}</Tag>
        </template>
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex items-center gap-2 border-0 border-b border-solid border-kb-line px-3 pb-2.5">
            <Input
              :model-value="search"
              size="sm"
              clearable
              class="min-w-0 flex-1"
              :placeholder="t('tasks.drawerSearchPlaceholder')"
              @update:model-value="$emit('update:search', String($event ?? ''))"
            >
              <template #prefix><Search /></template>
            </Input>
            <Button
              variant="ghost"
              size="sm"
              :disabled="nonRunningTasksCount === 0"
              @click.stop="$emit('clear-finished-tasks')"
            >
              {{ t("tasks.drawerClearAll", { n: nonRunningTasksCount }) }}
            </Button>
          </div>
          <div class="flex min-h-0 min-w-0 flex-1 flex-col px-3 pb-3 pt-2.5">
            <Empty v-if="!loading && search.trim() && tasks.length === 0" :description="t('tasks.drawerSearchEmpty')">
              <template #icon><SearchX /></template>
            </Empty>
            <div
              v-loading="showLoading && tasks.length === 0"
              class="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden"
              v-bind="containerProps"
              @scroll="handleTasksListScroll"
            >
              <div v-bind="wrapperProps">
                <!-- 行高须与 TASK_DRAWER_ITEM_HEIGHT 相同 -->
                <div
                  v-for="item in virtualList"
                  :key="item.data.id"
                  class="box-border h-[166px] min-w-0 max-w-full px-1 pb-2.5"
                >
                  <div
                    class="relative box-border h-full min-w-0 max-w-full overflow-hidden rounded-kb-lg border border-solid py-2.5 pl-3.5 pr-8 transition-colors duration-200"
                    :class="item.data.status === 'failed' ? CARD_FAILED : CARD_NORMAL"
                    @contextmenu="(e) => handleTaskContextMenu(e, item.data)"
                  >
                    <!-- 禁用的按钮不响应指针，说明文字挂在外层 -->
                    <div
                      class="absolute right-1.5 top-1.5 z-[3]"
                      :title="
                        isTaskRunning(item.data) ? t('tasks.drawerDeleteTaskRunning') : t('tasks.drawerDeleteTask')
                      "
                    >
                      <Button
                        variant="ghost-danger"
                        size="icon-sm"
                        :disabled="isTaskRunning(item.data)"
                        :aria-label="t('tasks.drawerDeleteTask')"
                        @click="$emit('delete-task', item.data.id)"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div
                      class="grid h-full min-h-0 min-w-0 grid-cols-[52px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 overflow-hidden"
                    >
                      <div class="col-start-1 row-start-1 self-start pt-0.5" aria-hidden="true">
                        <div
                          class="grid size-9 place-items-center overflow-hidden rounded-kb-md border border-solid border-kb-line bg-kb-fill-light text-kb-fg-subtle [&_svg]:size-5"
                        >
                          <img
                            v-if="drawerPluginIconSrc(item.data.pluginId)"
                            :src="String(drawerPluginIconSrc(item.data.pluginId))"
                            alt=""
                            class="size-full object-contain"
                          />
                          <LayoutGrid v-else />
                        </div>
                      </div>
                      <div class="col-start-2 row-start-1 min-w-0">
                        <TaskSummaryRow
                          :task="item.data"
                          layout="stacked"
                          :show-schedule-button="isScheduledTask(item.data)"
                          :scheduled-task-aria-label="scheduledTaskAriaLabel(item.data)"
                          show-status-tag
                          stacked-omit-image-log-actions
                          @open-task-images="(id) => $emit('open-task-images', id)"
                          @open-task-log="openTaskLog($event)"
                          @open-schedule-config="handleOpenTaskScheduleConfig($event)"
                        />
                      </div>
                      <!-- 三行：进度条（无进度时也占高，按钮行不跳）、并发与百分比、按钮 -->
                      <div
                        class="col-span-full row-start-2 grid h-full min-h-0 min-w-0 grid-rows-[20px_16px_auto] gap-y-1"
                      >
                        <div class="row-start-1 flex min-w-0 flex-col justify-center overflow-hidden">
                          <div v-if="shouldShowTaskProgressBar(item.data)" class="flex min-w-0 items-center gap-1">
                            <Progress
                              :value="taskProgressPercent(item.data)"
                              :tone="taskProgressTone(item.data.status)"
                            />
                            <Popconfirm
                              v-if="isTaskRunning(item.data)"
                              :title="t('tasks.drawerStopConfirm')"
                              :confirm-text="t('common.confirm')"
                              side="bottom"
                              align="end"
                              @confirm="$emit('cancel-task', item.data.id)"
                            >
                              <Button
                                variant="ghost-danger"
                                size="icon-xs"
                                :title="t('tasks.drawerStop')"
                                :aria-label="t('tasks.drawerStop')"
                                @click.stop
                              >
                                <X />
                              </Button>
                            </Popconfirm>
                          </div>
                        </div>
                        <div class="row-start-2 flex min-w-0 items-center justify-between overflow-hidden">
                          <TaskConcurrencyControl
                            v-if="shouldShowTaskConcurrency(item.data)"
                            :task-id="item.data.id"
                            :limit="item.data.maxConcurrentDownloads ?? null"
                            :in-flight="taskInFlight.get(item.data.id) ?? 0"
                            :editable="item.data.status === 'pending' || item.data.status === 'running'"
                            @updated="$emit('task-patched', $event)"
                          />
                          <span
                            v-if="shouldShowTaskProgressBar(item.data)"
                            class="ml-auto text-[11px] leading-[1.2] tabular-nums text-kb-fg-subtle"
                          >
                            {{ taskProgressText(item.data) }}
                          </span>
                        </div>
                        <div
                          class="row-start-3 flex min-w-0 flex-wrap items-center justify-between gap-x-1.5 gap-y-1 overflow-hidden"
                        >
                          <div class="flex min-w-0 flex-[1_1_0] flex-wrap items-center gap-1">
                            <Button
                              size="sm"
                              :title="t('tasks.openRunParams')"
                              @click.stop="openRunParamsDialog(item.data)"
                            >
                              {{ t("tasks.drawerTaskActionParams") }}
                            </Button>
                            <Button
                              size="sm"
                              :title="t('tasks.drawerViewImages')"
                              @click.stop="$emit('open-task-images', item.data.id)"
                            >
                              {{ t("tasks.drawerTaskActionImages") }}
                            </Button>
                            <Button size="sm" :title="t('tasks.drawerViewLog')" @click.stop="openTaskLog(item.data.id)">
                              {{ t("tasks.drawerTaskActionLog") }}
                            </Button>
                            <Button
                              v-if="shouldShowTaskWebviewButton(item.data)"
                              size="sm"
                              :title="t('tasks.openTaskWebview')"
                              @click.stop="openTaskWindow(item.data.id)"
                            >
                              {{ t("tasks.drawerTaskActionWebview") }}
                            </Button>
                          </div>
                          <div
                            v-if="item.data.startTime != null && Number(item.data.startTime) > 0"
                            class="min-w-0 max-w-full shrink truncate text-right text-[11px] leading-[1.2] text-kb-fg-subtle"
                            :title="formatDrawerTaskStartFull(item.data.startTime)"
                          >
                            {{ formatDrawerTaskStart(item.data.startTime) }}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div
              v-if="hasMore && showLoading && tasks.length > 0"
              class="flex shrink-0 items-center justify-center gap-2 pt-2 text-[13px] text-kb-fg-muted"
            >
              <Spinner :size="14" />
              <span>{{ t("common.loading") }}</span>
            </div>
          </div>
        </div>
      </CollapsibleDrawerPanel>
    </div>

    <TaskParamsDialog
      :open="runParamsOpen"
      :task="runParamsTask"
      @close="runParamsOpen = false"
      @closed="runParamsTask = null"
    />
    <TaskLogDialog ref="taskLogDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { Download, LayoutGrid, Search, SearchX, Trash2, X } from "@lucide/vue";
import { invoke } from "../../api";
import CollapsibleDrawerPanel from "../common/CollapsibleDrawerPanel.vue";
import TaskLogDialog from "./TaskLogDialog.vue";
import TaskParamsDialog from "./TaskParamsDialog.vue";
import TaskSummaryRow, { type TaskSummaryRowTask } from "./TaskSummaryRow.vue";
import TaskConcurrencyControl from "./TaskConcurrencyControl.vue";
import { useTaskDrawerStore } from "../../stores/taskDrawer";
import { usePluginStore } from "../../stores/plugins";
import type { PluginManifestText } from "../../stores/plugins";
import type { TaskRunParamsTask } from "./TaskRunParamsContent.vue";
import { trackEvent } from "../../track/umami";
import { kameMessage } from "../../utils/kameMessage";
import { downloadPoller, useDownloadStateStore, type ActiveDownloadInfo } from "../../stores/downloadState";
import { vLoading } from "@/components/ui/loading";
import Button from "@/components/ui/Button.vue";
import Empty from "@/components/ui/Empty.vue";
import Input from "@/components/ui/Input.vue";
import Popconfirm from "@/components/ui/Popconfirm.vue";
import Progress from "@/components/ui/Progress.vue";
import Spinner from "@/components/ui/Spinner.vue";
import Tag from "@/components/ui/Tag.vue";

const { t, locale } = useI18n();
const pluginStore = usePluginStore();
const taskDrawerStore = useTaskDrawerStore();
const downloadStateStore = useDownloadStateStore();

type TaskStatus = "pending" | "running" | "waiting_downloads" | "completed" | "failed" | "canceled";
type ScriptTask = {
  id: string;
  pluginId: string;
  runConfigId?: string;
  runConfigName?: string | null;
  triggerSource?: "manual" | "scheduled" | string;
  retryCount?: number;
  retryAttempt?: number;
  retryRootId?: string;
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
  maxConcurrentDownloads?: number | null;
  isDryRun: boolean;
};

const props = withDefaults(
  defineProps<{
    tasks: ScriptTask[];
    total: number;
    hasMore: boolean;
    /** 真实加载态：首屏或触底请求在途，用于并发守卫与空态判断 */
    loading: boolean;
    /** 延迟后的加载态（useLoadingDelay），只用于转圈，快速返回时不闪 */
    showLoading: boolean;
    search: string;
    plugins?: Array<{ id: string; name?: PluginManifestText }>;
    /** active=false 时停止下载轮询与事件监听（main drawer 关闭时用） */
    active?: boolean;
    /** 可关闭右键菜单 */
    enableContextMenu?: boolean;
    /**
     * 任务是否可「打开 WebView」（已由调用方判断运行状态与后端）。
     * 缺省时按插件静态 `scriptType === "js"` 判断；后端按任务参数决定的内建任务需由应用层传入。
     */
    canOpenWebview?: (task: ScriptTask) => boolean;
  }>(),
  { plugins: () => [], active: true, enableContextMenu: true },
);

const emit = defineEmits<{
  (e: "delete-task", taskId: string): void;
  /** 已在叉号下方的小确认框里确认过，父组件直接停止，不要再弹确认 */
  (e: "cancel-task", taskId: string): void;
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-schedule-config", task: TaskSummaryRowTask): void;
  (e: "clear-finished-tasks"): void;
  (e: "task-contextmenu", payload: { x: number; y: number; task: ScriptTask }): void;
  (e: "load-more"): void;
  (e: "update:search", value: string): void;
  (e: "task-patched", task: import("../../stores/crawler").CrawlTask): void;
}>();

const nonRunningTasksCount = computed(() => taskDrawerStore.finishedTasksCount);

/** 任务数量展示：有总分页时显示总数，否则显示当前条数 */
const displayTaskCount = computed(() => props.total);

function isCanceledTaskStatus(status: string): boolean {
  return status === "canceled" || status === "cancelled";
}

/**
 * pending 尚未开始、completed 已经结束，都不挂条；其余（running / failed / canceled）显示。
 * running 一进入就显示，从 0% 起步 —— 不等第一个 progress 事件。
 */
function shouldShowTaskProgressBar(task: ScriptTask): boolean {
  const s = task.status;
  return s !== "pending" && s !== "completed";
}

function taskProgressPercent(task: ScriptTask): number {
  const p = Number(task.progress ?? 0);
  if (!Number.isFinite(p)) return 0;
  // 保留两位小数：取整会把细粒度进度抹平（图多的任务里 1% 也是好些张）
  return Math.round(Math.min(100, Math.max(0, p)) * 100) / 100;
}

/** 百分比文字固定两位小数：默认格式会随数值在 "33%" / "33.4%" 间变宽，带动条抖动。 */
function taskProgressText(task: ScriptTask): string {
  return `${taskProgressPercent(task).toFixed(2)}%`;
}

/** failed：红条；canceled：灰条；其余（运行中）强调色 */
function taskProgressTone(status: string): "accent" | "danger" | "muted" {
  if (status === "failed") return "danger";
  if (isCanceledTaskStatus(status)) return "muted";
  return "accent";
}

/** 任务卡片外框：失败的铺一层淡危险色 */
const CARD_NORMAL = "border-kb-line bg-kb-surface-raised hover:bg-kb-fill-lighter";
const CARD_FAILED =
  "border-[color-mix(in_srgb,var(--kb-danger)_22%,transparent)] bg-[color-mix(in_srgb,var(--kb-danger)_4%,transparent)] hover:bg-[color-mix(in_srgb,var(--kb-danger)_8%,transparent)]";

/** 抽屉任务行图标：统一读 pluginStore 缓存。 */
function drawerPluginIconSrc(pluginId: string): string | undefined {
  if (!pluginId) return undefined;
  return pluginStore.pluginIconSrc(pluginId);
}

/** 与虚拟列表行高一致（须与模板里每行的 h-[166px] 相同） */
const TASK_DRAWER_ITEM_HEIGHT = 166;

/** 运行中（含等待下载收尾）的任务不能直接删除，须先停止 */
const isTaskRunning = (task: ScriptTask) => task.status === "running" || task.status === "waiting_downloads";

/** 任务搜索：按插件 id 与当前语言下的插件名做不区分大小写的子串匹配 */
const {
  list: virtualList,
  containerProps,
  wrapperProps,
  scrollTo: scrollTasksTo,
} = useVirtualList(
  computed(() => props.tasks),
  {
    itemHeight: TASK_DRAWER_ITEM_HEIGHT,
    overscan: 6,
  },
);
// 搜索词变化后回到顶部：否则沿用旧 scrollTop，结果比原列表短时可视区落在结果之外，整列空白
watch(
  () => props.search,
  () => scrollTasksTo(0),
);

const runParamsOpen = ref(false);
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
  runParamsOpen.value = true;
}

async function loadMoreTasks() {
  if (props.loading || !props.hasMore) return;
  emit("load-more");
}

function handleTasksListScroll(e: Event) {
  const el = e.target as HTMLElement | null;
  if (!el || props.loading || !props.hasMore) return;
  const { scrollTop, clientHeight, scrollHeight } = el;
  const threshold = 60;
  if (scrollTop + clientHeight >= scrollHeight - threshold) {
    void loadMoreTasks();
  }
}

type DownloadItem = ActiveDownloadInfo;
const allDownloads = computed(() => downloadStateStore.entries);
const activeDownloadsRunningCount = computed(
  () =>
    allDownloads.value.filter((d) => {
      const st = d.state ?? "";
      return st !== "completed" && st !== "failed" && st !== "canceled";
    }).length,
);
const orderedActiveDownloads = computed(() => allDownloads.value);
const taskInFlight = computed(() => {
  const counts = new Map<string, number>();
  for (const download of allDownloads.value) {
    if ((download.state ?? "") === "completed" || download.state === "failed" || download.state === "canceled")
      continue;
    counts.set(download.taskId, (counts.get(download.taskId) ?? 0) + 1);
  }
  return counts;
});

const shouldShowTaskConcurrency = (task: ScriptTask) =>
  task.status === "pending" || task.status === "running" || task.status === "waiting_downloads";

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

const downloadStateTone = (d: DownloadItem): "neutral" | "accent" | "success" | "danger" => {
  const st = d.state ?? "";
  if (st === "failed") return "danger";
  if (st === "completed" || st === "processing") return "success";
  if (st === "extracting" || st === "downloading") return "accent";
  return "neutral";
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

const shouldShowDownloadProgress = (d: DownloadItem) => (d.state ?? "") === "downloading";

const downloadProgressPercent = (d: DownloadItem) => {
  const total = d.totalBytes;
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((d.receivedBytes / total) * 100)));
};

const downloadProgressText = (d: DownloadItem) => {
  const total = d.totalBytes;
  if (!total || total <= 0) return `${formatBytes(d.receivedBytes)} / ?`;
  return `${formatBytes(d.receivedBytes)} / ${formatBytes(total)}`;
};

const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);
const isScheduledTask = (task: ScriptTask) => task.triggerSource === "scheduled";

const isJsTask = (pluginId: string) =>
  pluginStore.plugins.find((plugin) => plugin.id === pluginId)?.scriptType === "js";

const shouldShowTaskWebviewButton = (task: ScriptTask) =>
  props.canOpenWebview
    ? props.canOpenWebview(task)
    : (task.status === "running" || task.status === "waiting_downloads") && isJsTask(task.pluginId);

async function openTaskWindow(taskId: string) {
  const id = String(taskId || "").trim();
  if (!id) return;
  const task = props.tasks.find((t) => t.id === id);
  if (task) trackTaskDrawerAction("open_webview", task);
  try {
    await invoke("show_crawler_window", { taskId: id });
    kameMessage.success(t("tasks.openTaskWebviewSuccess"));
  } catch (error) {
    kameMessage.error(String(error));
  }
}

const getRunConfigName = (task: ScriptTask) => {
  const runConfigId = `${task.runConfigId ?? ""}`.trim();
  if (!runConfigId) return "-";
  if (task.runConfigName == null) return runConfigId;
  return resolveConfigText(task.runConfigName as any, locale.value) || runConfigId;
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

defineExpose({
  openRunParams: (taskId: string) => {
    const task = props.tasks.find((item) => item.id === taskId);
    if (task) openRunParamsDialog(task);
  },
  openTaskLog,
});

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

watch(
  () => !!props.active,
  (val) => {
    if (val) downloadPoller.wake();
  },
  { immediate: true },
);
</script>

<style scoped>
/* 下载条目进入 / 退出动画（completed 0.2s 展示 + 列表更新） */
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
</style>
