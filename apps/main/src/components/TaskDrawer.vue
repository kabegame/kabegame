<template>
  <!-- Android：自研全宽抽屉，支持划入动画与拖拽滑出、背景透明度随拖拽变化 -->
  <AndroidDrawer
    v-if="IS_ANDROID"
    v-model="visible"
    @open="handleDrawerOpen">
    <template #header>
      <h3 class="task-drawer-android-title">任务列表</h3>
    </template>
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="visible" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById" @confirm-task-dump="handleConfirmTaskDumpById"
      @task-contextmenu="openTaskContextMenu" />
  </AndroidDrawer>
  <el-drawer v-else v-model="visible" title="任务列表" :size="drawerSize" direction="rtl" :with-header="true" :append-to-body="true"
    :modal-class="'task-drawer-modal'" class="task-drawer drawer-max-width" @open="handleDrawerOpen">
    <TaskDrawerContent :tasks="tasks" :plugins="plugins" :active="visible" @clear-finished-tasks="handleDeleteAllTasks"
      @open-task-images="handleOpenTaskImagesById" @delete-task="handleDeleteTaskById"
      @cancel-task="handleCancelTaskById" @confirm-task-dump="handleConfirmTaskDumpById"
      @task-contextmenu="openTaskContextMenu" />
  </el-drawer>

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
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useRouter } from "vue-router";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { IS_ANDROID } from "@kabegame/core/env";
import AndroidDrawer from "@kabegame/core/components/AndroidDrawer.vue";
import TaskDrawerContent from "@kabegame/core/components/task/TaskDrawerContent.vue";
import TaskContextMenu from "./contextMenu/TaskContextMenu.vue";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";

interface Props {
  modelValue: boolean;
  tasks: any[];
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const router = useRouter();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
});

const modalStack = useModalStackStore();
const modalStackId = ref<string | null>(null);

watch(
  () => visible.value,
  (val) => {
    if (val && IS_ANDROID) {
      modalStackId.value = modalStack.push(() => {
        visible.value = false;
      });
    } else if (!val && modalStackId.value) {
      modalStack.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

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
const nonRunningTasksCount = computed(() => props.tasks.filter((t) => t.status !== "running" && t.status !== "pending").length);


const getPluginName = (pluginId: string) => {
  const plugin = plugins.value.find((p) => p.id === pluginId);
  return plugin?.name || pluginId;
};

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
    ElMessage.warning("请输入配置名称");
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

const handleDrawerOpen = async () => {
  // 预加载任务详情页代码块，避免首次跳转卡在懒加载上
  prefetchTaskDetailView();
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
      "确定要停止这个任务吗？已下载的图片将保留，未开始的任务将取消。",
      "停止任务",
      { type: "warning" }
    );
    await crawlerStore.stopTask(task.id);
    ElMessage.info("任务已请求停止");
  } catch (error) {
    if (error !== "cancel") {
      // 静默处理错误，不显示弹窗，任务状态会通过后端事件自动更新
      console.error("停止任务失败:", error);
    }
  }
};

const handleConfirmTaskDumpById = async (taskId: string) => {
  try {
    await crawlerStore.confirmTaskRhaiDump(taskId);
    ElMessage.success("已确认");
  } catch (e) {
    console.error("确认 dump 失败:", e);
    ElMessage.error("确认失败");
  }
};

const handleDeleteTaskById = async (taskId: string) => {
  const task = props.tasks.find((t) => t.id === taskId);
  if (!task) return;
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
    ElMessage.success("任务已删除");
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error("删除失败");
    }
  }
};

const handleOpenTaskImagesById = (taskId: string) => {
  const task = props.tasks.find((t) => t.id === taskId);
  if (!task) return;
  // 预加载 + 先触发导航，再在下一帧关闭 drawer（避免关闭时的大量 DOM 更新抢占首跳转）
  prefetchTaskDetailView();
  void router.push(`/tasks/${task.id}`);
  requestAnimationFrame(() => {
    visible.value = false;
  });
};

// 预加载 TaskDetail 路由的代码块（第一次进入会明显变快）
let taskDetailPrefetchPromise: Promise<unknown> | null = null;
const prefetchTaskDetailView = () => {
  if (!taskDetailPrefetchPromise) {
    taskDetailPrefetchPromise = import("@/views/TaskDetail.vue");
  }
};

const handleDeleteAllTasks = async () => {
  if (nonRunningTasksCount.value === 0) {
    ElMessage.warning("没有可清除的任务（所有任务都是等待中或运行中）");
    return;
  }
  try {
    const pendingCount = props.tasks.filter((t) => t.status === "pending").length;
    const runningCount = props.tasks.filter((t) => t.status === "running").length;
    const preservedCount = pendingCount + runningCount;
    const deletableCount = nonRunningTasksCount.value;
    const msg = preservedCount > 0
      ? `确定要删除所有已完成/失败/已取消的任务吗？共 ${deletableCount} 个（${pendingCount} 个等待中的任务和 ${runningCount} 个运行中的任务将被保留）。`
      : `确定要删除所有任务吗？共 ${deletableCount} 个。`;
    await ElMessageBox.confirm(msg, "清除所有任务", { type: "warning" });

    // 调用后端命令批量清除
    const clearedCount = await invoke<number>("clear_finished_tasks");
    // 重新获取任务列表
    await crawlerStore.loadTasks();
    ElMessage.success(`已清除 ${clearedCount} 个任务`);
  } catch (error) {
    if (error !== "cancel") {
      console.error("清除任务失败:", error);
      ElMessage.error("清除失败");
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
