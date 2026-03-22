<template>
  <!-- Android：自研全宽抽屉，支持划入动画与拖拽滑出、背景透明度随拖拽变化 -->
  <AndroidDrawer v-if="IS_ANDROID" v-model="visible">
    <template #header>
      <h3 class="task-drawer-android-title">{{ $t('tasks.taskList') }}</h3>
    </template>
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="visible" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById"
      @task-contextmenu="openTaskContextMenu" />
  </AndroidDrawer>
  <el-drawer v-else v-model="visible" :title="$t('tasks.taskList')" :size="drawerSize" direction="rtl" :with-header="true"
    :append-to-body="true" :modal-class="'task-drawer-modal'" class="task-drawer drawer-max-width">
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="visible" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById"
      @task-contextmenu="openTaskContextMenu" />
  </el-drawer>

  <el-dialog v-model="saveConfigVisible" :title="$t('tasks.saveAsConfig')" width="520px" :close-on-click-modal="false"
    class="save-config-dialog" @close="resetSaveConfigForm">
    <el-form label-width="80px">
      <el-form-item :label="$t('common.name')" required>
        <el-input v-model="saveConfigName" :placeholder="$t('common.configNamePlaceholder')" />
      </el-form-item>
      <el-form-item :label="$t('common.description')">
        <el-input v-model="saveConfigDescription" :placeholder="$t('common.configDescPlaceholder')" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="saveConfigVisible = false">{{ $t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="savingConfig" @click="confirmSaveTaskAsConfig">{{ $t('common.save') }}</el-button>
    </template>
  </el-dialog>

  <TaskContextMenu :visible="contextMenuVisible" :position="contextMenuPos" :task="contextMenuTask"
    @close="closeContextMenu" @command="handleContextAction" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "vue-router";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { IS_ANDROID } from "@kabegame/core/env";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import TaskDrawerContent from "@kabegame/core/components/task/TaskDrawerContent.vue";
import TaskContextMenu from "./contextMenu/TaskContextMenu.vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

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

const router = useRouter();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});

useModalBack(visible);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

// 任务右键菜单
const contextMenuVisible = ref(false);
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTask = ref<any | null>(null);

// 保存为运行配置弹窗
const saveConfigVisible = ref(false);
useModalBack(saveConfigVisible);
const savingConfig = ref(false);
const saveConfigTask = ref<any | null>(null);
const saveConfigName = ref("");
const saveConfigDescription = ref("");

const plugins = computed(() => pluginStore.plugins);
const nonRunningTasksCount = computed(() => props.tasks.filter((t) => t.status !== "running" && t.status !== "pending").length);


const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

// 右键菜单（由 TaskDrawerContent 转发）
const openTaskContextMenu = (payload: { x: number; y: number; task: any }) => {
  contextMenuTask.value = payload.task;
  contextMenuVisible.value = true;
  contextMenuPos.value = { x: payload.x, y: payload.y };
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
  saveConfigVisible.value = true;
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
    });
    ElMessage.success(t('tasks.saveConfigSuccess'));
    saveConfigVisible.value = false;
    resetSaveConfigForm();
  } catch (error) {
    console.error("保存为配置失败:", error);
    ElMessage.error(t('tasks.saveFailed'));
  } finally {
    savingConfig.value = false;
  }
};

const handleGlobalClick = () => {
  if (contextMenuVisible.value) {
    closeContextMenu();
  }
};

onMounted(async () => {
  window.addEventListener("click", handleGlobalClick);

  // 仅在应用启动时加载任务列表（TaskDrawer 是单例，onMounted 只会执行一次）
  await crawlerStore.loadTasks();
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
  void router.push(`/tasks/${task.id}`);
  requestAnimationFrame(() => {
    visible.value = false;
  });
};

const handleDeleteAllTasks = async () => {
  if (nonRunningTasksCount.value === 0) {
    ElMessage.warning(t('tasks.noTasksToClear'));
    return;
  }
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
    // 重新获取任务列表
    await crawlerStore.loadTasks();
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

.task-drawer-android-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
</style>
