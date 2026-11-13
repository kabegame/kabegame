<template>
  <!-- 紧凑布局（Android / 窄屏 Web）：自研全宽抽屉，支持划入动画与拖拽滑出、背景透明度随拖拽变化；
       不传 z-index，由它自己占栈位（层级与 Android 返回键） -->
  <AndroidDrawer v-if="uiStore.isCompact" :model-value="drawerOpen" @update:model-value="setDrawerOpen">
    <template #header>
      <div class="flex w-full items-center justify-between gap-2">
        <h3 class="m-0 text-[17px] font-600 text-kb-fg">{{ $t("tasks.taskList") }}</h3>
        <Tooltip v-if="IS_ANDROID && isOptimized" :content="$t('common.batteryOptimizationTooltip')">
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="$t('common.batteryOptimizationTooltip')"
            @click="onBatteryIconClick"
          >
            <Zap class="text-kb-warning" />
          </Button>
        </Tooltip>
      </div>
    </template>
    <TaskDrawerContent
      ref="drawerContentRef"
      :tasks="tasks"
      :total="total"
      :has-more="hasMore"
      :loading="loading"
      :show-loading="showLoading"
      :search="taskDrawerStore.search"
      :plugins="plugins"
      :active="drawerOpen"
      :can-open-webview="canOpenWebview"
      @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById"
      @delete-task="handleDeleteTaskById"
      @cancel-task="handleStopTaskById"
      @open-task-schedule-config="handleOpenTaskScheduleConfig"
      @task-contextmenu="openTaskContextMenu"
      @load-more="loadMore"
      @update:search="taskDrawerStore.search = $event"
      @task-patched="(task) => patch(task.id, task)"
    />
  </AndroidDrawer>
  <!-- 宽屏：右侧面板（Sheet 自己接 Esc、点遮罩与 Android 返回键） -->
  <Sheet
    v-else
    :open="drawerOpen"
    :title="$t('tasks.taskList')"
    :size="460"
    body-class="flex flex-col"
    @update:open="setDrawerOpen"
  >
    <TaskDrawerContent
      ref="drawerContentRef"
      :tasks="tasks"
      :total="total"
      :has-more="hasMore"
      :loading="loading"
      :show-loading="showLoading"
      :search="taskDrawerStore.search"
      :plugins="plugins"
      :active="drawerOpen"
      :can-open-webview="canOpenWebview"
      @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById"
      @delete-task="handleDeleteTaskById"
      @cancel-task="handleStopTaskById"
      @open-task-schedule-config="handleOpenTaskScheduleConfig"
      @task-contextmenu="openTaskContextMenu"
      @load-more="loadMore"
      @update:search="taskDrawerStore.search = $event"
      @task-patched="(task) => patch(task.id, task)"
    />
  </Sheet>

  <Dialog v-model:open="saveConfigOpen" :title="$t('tasks.saveAsConfig')" :width="520" :close-on-overlay="false">
    <div class="flex flex-col gap-4">
      <Field :label="$t('common.name')" required>
        <Input v-model="saveConfigName" :placeholder="$t('common.configNamePlaceholder')" />
      </Field>
      <Field :label="$t('common.description')">
        <Input v-model="saveConfigDescription" :placeholder="$t('common.configDescPlaceholder')" />
      </Field>
    </div>
    <template #footer>
      <Button @click="saveConfigOpen = false">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="savingConfig" @click="confirmSaveTaskAsConfig">
        <Spinner v-if="savingConfig" :size="14" />
        {{ $t("common.save") }}
      </Button>
    </template>
  </Dialog>

  <Teleport to="body">
    <TaskContextMenu
      :visible="contextMenuModal.isOpen.value"
      :z-index="contextMenuModal.zIndex.value"
      :position="contextMenuPos"
      :task="contextMenuTask"
      :can-rerun="contextMenuTask ? canRerun(contextMenuTask) : false"
      @close="closeContextMenu"
      @command="handleContextAction"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { canOpenTaskWebview } from "@/utils/webpageCollect";
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { Zap } from "@lucide/vue";
import { invoke } from "@/api/rpc";
import { useRoute, useRouter } from "vue-router";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { useCrawlerStore, type CrawlTask } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { IS_ANDROID } from "@/env";
import { trackEvent } from "@/track/umami";
import AndroidDrawer from "@/components/AndroidDrawer.vue";
import TaskDrawerContent from "@/components/task/TaskDrawerContent.vue";
import TaskContextMenu from "./contextMenu/TaskContextMenu.vue";
import { useModal } from "@/composables/useModal";
import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";
import { useUiStore } from "@/stores/ui";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useTaskRerun } from "@/composables/useTaskRerun";
import { usePagedTaskList } from "@/composables/usePagedTaskList";
import { taskSearchPath } from "@/services/tasks";
import { useTaskDrawerStore } from "@/stores/taskDrawer";
import { messageBox } from "@/components/ui/messageBox";
import Button from "@/components/ui/Button.vue";
import Dialog from "@/components/ui/Dialog.vue";
import Field from "@/components/ui/Field.vue";
import Input from "@/components/ui/Input.vue";
import Sheet from "@/components/ui/Sheet.vue";
import Spinner from "@/components/ui/Spinner.vue";
import Tooltip from "@/components/ui/Tooltip.vue";

interface Props {
  modelValue: boolean;
}

interface Emits {
  (e: "update:modelValue", value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();
const { t } = useI18n();

const route = useRoute();
const router = useRouter();
const crawlerStore = useCrawlerStore();
const autoConfigDialog = useAutoConfigDialogStore();
const pluginStore = usePluginStore();
const uiStore = useUiStore();
const taskDrawerStore = useTaskDrawerStore();

const normalizedSearch = computed(() => taskDrawerStore.search.trim().toLowerCase());
const matchingPluginIds = computed(() => {
  const query = normalizedSearch.value;
  if (!query) return [];
  return pluginStore.plugins
    .filter((plugin) => pluginStore.pluginLabel(plugin.id).toLowerCase().includes(query))
    .map((plugin) => plugin.id);
});
const taskList = usePagedTaskList({
  basePath: () => taskSearchPath(taskDrawerStore.search, matchingPluginIds.value),
});
const { items: tasks, total, hasMore, loading, showLoading, loadMore, patch, refresh, start, stop } = taskList;

// 开关状态只有 props.modelValue 一份；两种承载（AndroidDrawer / Sheet）各自接返回栈与层级，这里不再占栈位
const drawerOpen = computed(() => props.modelValue);
function setDrawerOpen(open: boolean) {
  if (!open && props.modelValue) emit("update:modelValue", false);
}

const batteryStore = useBatteryOptimizationStore();
const { isOptimized } = storeToRefs(batteryStore);

watch(drawerOpen, (open) => {
  if (open) void start();
  else stop();
  if (open && IS_ANDROID) {
    void batteryStore.checkAndPromptIfNeeded();
  }
});

async function onBatteryIconClick() {
  await batteryStore.checkAndPromptIfNeeded({ force: true });
}

// 任务右键菜单
const contextMenuModal = useModal({
  onClose: () => {
    contextMenuTask.value = null;
  },
});
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTask = ref<CrawlTask | null>(null);
const drawerContentRef = ref<InstanceType<typeof TaskDrawerContent> | null>(null);

// 保存为运行配置弹窗
const saveConfigOpen = ref(false);
watch(saveConfigOpen, (open) => {
  if (!open) resetSaveConfigForm();
});
const savingConfig = ref(false);
const saveConfigTask = ref<CrawlTask | null>(null);
const saveConfigName = ref("");
const saveConfigDescription = ref("");

const plugins = computed(() => pluginStore.plugins);
// 网页收集的后端是每次任务的参数，不能只看插件静态 scriptType
const canOpenWebview = (task: Parameters<typeof canOpenTaskWebview>[0]) =>
  canOpenTaskWebview(task, pluginStore.plugins);
const nonRunningTasksCount = computed(() => taskDrawerStore.finishedTasksCount);

const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

function trackTaskDrawerAction(action: "view_images" | "delete_task", task: any) {
  trackEvent("task_drawer_task_action", {
    action,
    taskId: task.id,
    pluginId: task.pluginId,
    status: task.status,
    triggerPage: route.path,
    routeName: route.name ? String(route.name) : "",
    url: currentUrl(),
  });
}

// 右键菜单（由 TaskDrawerContent 转发）
const openTaskContextMenu = (payload: { x: number; y: number; task: { id: string } }) => {
  // core 抽屉组件只认宽松的 ScriptTask，这里按 id 取回完整的 CrawlTask
  const task = tasks.value.find((t) => t.id === payload.task.id);
  if (!task) return;
  contextMenuTask.value = task;
  contextMenuPos.value = { x: payload.x, y: payload.y };
  contextMenuModal.open();
};

const closeContextMenu = () => {
  contextMenuModal.close();
};

const { canRerun, rerunTask } = useTaskRerun();

const handleContextAction = async (action: string) => {
  const task = contextMenuTask.value;
  closeContextMenu();
  if (!task) return;
  switch (action) {
    case "detail":
      drawerContentRef.value?.openRunParams(task.id);
      break;
    case "images":
      handleOpenTaskImagesById(task.id);
      break;
    case "log":
      await drawerContentRef.value?.openTaskLog(task.id);
      break;
    case "rerun":
      await rerunTask(task);
      break;
    case "stop":
      await handleCancelTaskById(task.id);
      break;
    case "delete":
      await handleDeleteTaskById(task.id);
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

const openSaveConfigDialog = (task: CrawlTask) => {
  const pluginName = getPluginName(task.pluginId);
  saveConfigTask.value = task;
  saveConfigName.value = pluginName;
  saveConfigDescription.value = "";
  saveConfigOpen.value = true;
};

const confirmSaveTaskAsConfig = async () => {
  const task = saveConfigTask.value;
  if (!task) return;
  const name = saveConfigName.value.trim();
  if (!name) {
    kameMessage.warning(t("tasks.enterConfigName"));
    return;
  }
  savingConfig.value = true;
  try {
    await crawlerStore.addRunConfig({
      name,
      description: saveConfigDescription.value.trim() || undefined,
      pluginId: task.pluginId,
      url: "",
      outputDir: task.outputDir,
      userConfig: task.userConfig ?? {},
      httpHeaders: task.httpHeaders ?? {},
      outputAlbumId: task.outputAlbumId,
      maxConcurrentDownloads: task.maxConcurrentDownloads ?? null,
      isDryRun: task.isDryRun,
      retryCount: task.retryCount,
      scheduleEnabled: false,
    });
    kameMessage.success(t("tasks.saveConfigSuccess"));
    saveConfigOpen.value = false;
    resetSaveConfigForm();
  } catch (error) {
    console.error("保存为配置失败:", error);
    kameMessage.error(t("tasks.saveFailed"));
  } finally {
    savingConfig.value = false;
  }
};

const handleGlobalClick = () => {
  if (contextMenuModal.isOpen.value) {
    closeContextMenu();
  }
};

onMounted(() => {
  window.addEventListener("click", handleGlobalClick);
});

onUnmounted(() => {
  window.removeEventListener("click", handleGlobalClick);
  if (searchTimer) clearTimeout(searchTimer);
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => taskDrawerStore.search,
  () => {
    if (!drawerOpen.value) return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      stop();
      void start();
    }, 250);
  },
);

/** 抽屉叉号已在 popconfirm 里确认过，这里直接停止 */
const handleStopTaskById = async (taskId: string) => {
  const task = tasks.value.find((t) => t.id === taskId);
  if (!task) return;
  try {
    await crawlerStore.stopTask(task.id);
    kameMessage.info(t("tasks.taskStopRequested"));
  } catch (error) {
    // 静默处理错误，不显示弹窗，任务状态会通过后端事件自动更新
    console.error("停止任务失败:", error);
  }
};

/** 右键菜单「停止」没有可挂靠的叉号，仍用确认弹窗 */
const handleCancelTaskById = async (taskId: string) => {
  try {
    await messageBox.confirm(t("tasks.stopTaskConfirm"), t("tasks.stopTaskTitle"), { type: "warning" });
  } catch {
    return;
  }
  await handleStopTaskById(taskId);
};

const handleDeleteTaskById = async (taskId: string) => {
  const task = tasks.value.find((t) => t.id === taskId);
  if (!task) return;
  // 运行中的任务须先停止，抽屉不再提供「停止并删除」
  if (task.status === "running" || task.status === "waiting_downloads") {
    kameMessage.warning(t("tasks.drawerDeleteTaskRunning"));
    return;
  }
  trackTaskDrawerAction("delete_task", task);
  if (await guardDesktopOnly("deleteTask", { needSuper: true })) return;
  try {
    await messageBox.confirm(t("tasks.deleteTaskConfirm"), t("tasks.confirmDelete"), { type: "warning" });
    await crawlerStore.deleteTask(task.id);
    refresh();
    taskDrawerStore.refreshCounts();
    kameMessage.success(t("tasks.taskDeleted"));
  } catch (error) {
    if (error !== "cancel") {
      kameMessage.error(t("tasks.deleteFailed"));
    }
  }
};

const handleOpenTaskImagesById = (taskId: string) => {
  const id = String(taskId || "").trim();
  if (!id) return;
  // 重试记录弹出层里的任务不一定在已加载的列表页里，照样跳转
  const task = tasks.value.find((t) => t.id === id);
  if (task) trackTaskDrawerAction("view_images", task);
  if (route.name === "TaskDetail") {
    router.replace({
      path: `/tasks/${id}`,
    });
  } else {
    router.push({
      path: `/tasks/${id}`,
    });
  }
  requestAnimationFrame(() => {
    setDrawerOpen(false);
  });
};

const handleOpenTaskScheduleConfig = (task: any) => {
  const runConfigId = String(task?.runConfigId ?? "").trim();
  if (!runConfigId) {
    kameMessage.warning(t("autoConfig.configDeleted"));
    return;
  }
  if (task.runConfigName == null) {
    kameMessage.warning(t("autoConfig.configDeleted"));
    return;
  }
  autoConfigDialog.openExisting(runConfigId, "view", { scrollSchedule: true });
};

const handleDeleteAllTasks = async () => {
  if (nonRunningTasksCount.value === 0) {
    kameMessage.warning(t("tasks.noTasksToClear"));
    return;
  }
  if (await guardDesktopOnly("deleteTask", { needSuper: true })) return;
  try {
    const pendingCount = taskDrawerStore.statusCounts.pending ?? 0;
    const runningCount =
      (taskDrawerStore.statusCounts.running ?? 0) + (taskDrawerStore.statusCounts.waiting_downloads ?? 0);
    const preservedCount = pendingCount + runningCount;
    const deletableCount = nonRunningTasksCount.value;
    const msg =
      preservedCount > 0
        ? t("tasks.clearAllTasksConfirmPreserved", {
            count: deletableCount,
            pending: pendingCount,
            running: runningCount,
          })
        : t("tasks.clearAllTasksConfirm", { count: deletableCount });
    await messageBox.confirm(msg, t("tasks.clearAllTasksTitle"), { type: "warning" });

    // 调用后端命令批量清除
    const result = await invoke<{ taskIds: string[]; count: number }>("clear_finished_tasks");
    refresh();
    taskDrawerStore.refreshCounts();
    kameMessage.success(t("tasks.tasksCleared", { count: result.count }));
  } catch (error) {
    if (error !== "cancel") {
      console.error("清除任务失败:", error);
      kameMessage.error(t("tasks.clearFailed"));
    }
  }
};
</script>
