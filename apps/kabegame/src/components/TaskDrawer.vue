<template>
  <!-- Android：自研全宽抽屉，支持划入动画与拖拽滑出、背景透明度随拖拽变化 -->
  <AndroidDrawer v-if="uiStore.isCompact" :model-value="modal.isOpen.value" :z-index="modal.zIndex.value" @update:model-value="modal.close">
    <template #header>
      <div class="task-drawer-android-header">
        <h3 class="task-drawer-android-title">{{ $t('tasks.taskList') }}</h3>
        <el-tooltip v-if="IS_ANDROID && isOptimized" :content="$t('common.batteryOptimizationTooltip')" placement="bottom">
          <el-button link type="warning" class="!p-1 shrink-0" @click="onBatteryIconClick">
            <el-icon :size="18"><Lightning /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </template>
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="modal.isOpen.value" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById" @open-task-schedule-config="handleOpenTaskScheduleConfig"
      @task-contextmenu="openTaskContextMenu" />
  </AndroidDrawer>
  <el-drawer v-else :model-value="modal.isOpen.value" :z-index="modal.zIndex.value" :title="$t('tasks.taskList')" size="460px" direction="rtl" :with-header="true"
    :append-to-body="true" :modal-class="'task-drawer-modal'" class="task-drawer drawer-max-width" @update:model-value="modal.close">
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="modal.isOpen.value" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById" @open-task-schedule-config="handleOpenTaskScheduleConfig"
      @task-contextmenu="openTaskContextMenu" />
  </el-drawer>

  <el-dialog :model-value="saveConfigModal.isOpen.value" :z-index="saveConfigModal.zIndex.value" :title="$t('tasks.saveAsConfig')" width="520px" :close-on-click-modal="false"
    class="save-config-dialog" @update:model-value="saveConfigModal.close" @close="resetSaveConfigForm">
    <el-form label-width="80px">
      <el-form-item :label="$t('common.name')" required>
        <el-input v-model="saveConfigName" :placeholder="$t('common.configNamePlaceholder')" />
      </el-form-item>
      <el-form-item :label="$t('common.description')">
        <el-input v-model="saveConfigDescription" :placeholder="$t('common.configDescPlaceholder')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="saveConfigModal.close()">{{ $t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="savingConfig" @click="confirmSaveTaskAsConfig">{{ $t('common.save')
        }}</el-button>
    </template>
  </el-dialog>

  <TaskContextMenu :visible="contextMenuModal.isOpen.value" :z-index="contextMenuModal.zIndex.value" :position="contextMenuPos" :task="contextMenuTask"
    @close="closeContextMenu" @command="handleContextAction" />
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { Lightning } from "@element-plus/icons-vue";
import { invoke } from "@/api/rpc";
import { useRoute, useRouter } from "vue-router";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { IS_ANDROID } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import TaskDrawerContent from "@kabegame/core/components/task/TaskDrawerContent.vue";
import TaskContextMenu from "./contextMenu/TaskContextMenu.vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";
import { useUiStore } from "@kabegame/core/stores/ui";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

interface Props {
  modelValue: boolean;
  tasks: any[];
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
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

const modal = useModal({ onClose: () => emit('update:modelValue', false) });
watch(() => props.modelValue, (v) => v ? modal.open() : modal.close(), { immediate: true });

const batteryStore = useBatteryOptimizationStore();
const { isOptimized } = storeToRefs(batteryStore);

watch(modal.isOpen, (open) => {
  if (open && IS_ANDROID) {
    void batteryStore.checkAndPromptIfNeeded();
  }
});

async function onBatteryIconClick() {
  await batteryStore.checkAndPromptIfNeeded({ force: true });
}

// 任务右键菜单
const contextMenuModal = useModal({ onClose: () => { contextMenuTask.value = null; } });
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTask = ref<any | null>(null);

// 保存为运行配置弹窗
const saveConfigModal = useModal();
const savingConfig = ref(false);
const saveConfigTask = ref<any | null>(null);
const saveConfigName = ref("");
const saveConfigDescription = ref("");

const plugins = computed(() => pluginStore.plugins);
const nonRunningTasksCount = computed(() => props.tasks.filter((t) => t.status !== "running" && t.status !== "pending").length);


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
const openTaskContextMenu = (payload: { x: number; y: number; task: any }) => {
  contextMenuTask.value = payload.task;
  contextMenuPos.value = { x: payload.x, y: payload.y };
  contextMenuModal.open();
};

const closeContextMenu = () => {
  contextMenuModal.close();
};

const handleContextAction = async (action: string) => {
  const task = contextMenuTask.value;
  closeContextMenu();
  if (!task) return;
  switch (action) {
    case "view":
      handleOpenTaskImagesById(task.id);
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

const openSaveConfigDialog = (task: any) => {
  const pluginName = getPluginName(task.pluginId);
  saveConfigTask.value = task;
  saveConfigName.value = pluginName;
  saveConfigDescription.value = "";
  saveConfigModal.open();
};

const confirmSaveTaskAsConfig = async () => {
  const task = saveConfigTask.value;
  if (!task) return;
  const name = saveConfigName.value.trim();
  if (!name) {
    ElMessage.warning(t('tasks.enterConfigName'));
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
      scheduleEnabled: false,
    });
    ElMessage.success(t('tasks.saveConfigSuccess'));
    saveConfigModal.close();
    resetSaveConfigForm();
  } catch (error) {
    console.error("保存为配置失败:", error);
    ElMessage.error(t('tasks.saveFailed'));
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
});

const handleCancelTaskById = async (taskId: string) => {
  const task = props.tasks.find((t) => t.id === taskId);
  if (!task) return;
  try {
    await ElMessageBox.confirm(
      t('tasks.stopTaskConfirm'),
      t('tasks.stopTaskTitle'),
      { type: "warning" }
    );
    await crawlerStore.stopTask(task.id);
    ElMessage.info(t('tasks.taskStopRequested'));
  } catch (error) {
    if (error !== "cancel") {
      // 静默处理错误，不显示弹窗，任务状态会通过后端事件自动更新
      console.error("停止任务失败:", error);
    }
  }
};

const handleDeleteTaskById = async (taskId: string) => {
  const task = props.tasks.find((t) => t.id === taskId);
  if (!task) return;
  trackTaskDrawerAction("delete_task", task);
  if (await guardDesktopOnly("deleteTask", { needSuper: true })) return;
  try {
    const needStop = task.status === "running";
    const msg = needStop
      ? t('tasks.deleteTaskConfirmRunning')
      : t('tasks.deleteTaskConfirm');
    await ElMessageBox.confirm(msg, t('tasks.confirmDelete'), { type: "warning" });

    if (needStop) {
      try {
        await crawlerStore.stopTask(task.id);
      } catch (err) {
        console.error("终止任务失败，已取消删除", err);
        ElMessage.error(t('tasks.stopFailedCancel'));
        return;
      }
    }

    await crawlerStore.deleteTask(task.id);
    ElMessage.success(t('tasks.taskDeleted'));
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(t('tasks.deleteFailed'));
    }
  }
};

const handleOpenTaskImagesById = (taskId: string) => {
  const task = props.tasks.find((t) => t.id === taskId);
  if (!task) return;
  trackTaskDrawerAction("view_images", task);
  if (route.name === 'TaskDetail') {
    router.replace({
      path: `/tasks/${task.id}`,
    });
  } else {
    router.push({
      path: `/tasks/${task.id}`,
    });
  }
  requestAnimationFrame(() => {
    modal.close();
  });
};

const handleOpenTaskScheduleConfig = (task: any) => {
  const runConfigId = String(task?.runConfigId ?? "").trim();
  if (!runConfigId) {
    ElMessage.warning(t("autoConfig.configDeleted"));
    return;
  }
  const runConfig = crawlerStore.runConfigById(runConfigId);
  if (!runConfig) {
    ElMessage.warning(t("autoConfig.configDeleted"));
    return;
  }
  autoConfigDialog.openExisting(runConfigId, "view", { scrollSchedule: true });
};

const handleDeleteAllTasks = async () => {
  if (nonRunningTasksCount.value === 0) {
    ElMessage.warning(t('tasks.noTasksToClear'));
    return;
  }
  if (await guardDesktopOnly("deleteTask", { needSuper: true })) return;
  try {
    const pendingCount = props.tasks.filter((t) => t.status === "pending").length;
    const runningCount = props.tasks.filter((t) => t.status === "running").length;
    const preservedCount = pendingCount + runningCount;
    const deletableCount = nonRunningTasksCount.value;
    const msg = preservedCount > 0
      ? t('tasks.clearAllTasksConfirmPreserved', { count: deletableCount, pending: pendingCount, running: runningCount })
      : t('tasks.clearAllTasksConfirm', { count: deletableCount });
    await ElMessageBox.confirm(msg, t('tasks.clearAllTasksTitle'), { type: "warning" });

    // 调用后端命令批量清除
    const clearedCount = await invoke<number>("clear_finished_tasks");
    crawlerStore.applyKeepOnlyPendingAndRunningTasks();
    ElMessage.success(t('tasks.tasksCleared', { count: clearedCount }));
  } catch (error) {
    if (error !== "cancel") {
      console.error("清除任务失败:", error);
      ElMessage.error(t('tasks.clearFailed'));
    }
  }
};
</script>

<style lang="scss">
/* 图片路径 tooltip 样式 */
.image-path-tooltip {
  max-width: 400px;
  padding: 8px 12px;
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

.task-drawer-android-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.task-drawer-android-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

/* 让抽屉主体参与 flex 高度传递，TaskDrawerContent 内「正在下载」列表才能 overflow 滚动 */
.task-drawer.el-drawer {
  display: flex;
  flex-direction: column;
}

.task-drawer :deep(.el-drawer__body) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
