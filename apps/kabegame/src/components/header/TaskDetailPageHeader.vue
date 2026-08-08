<template>
  <PageHeader
    :title="taskName || t('tasks.task')"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
    show-back
    @back="handleBack"
  >
    <template v-if="$slots.subtitle" #subtitle>
      <slot name="subtitle" />
    </template>
  </PageHeader>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";
import { usePageBridgeStore } from "@/stores/pageBridge";

interface Props {
  taskName?: string;
  /** 是否显示停止任务（仅当任务 running 时为 true，用于控制 Android fold 中是否显示停止） */
  showStopTask?: boolean;
  /** 是否显示打开当前 JS 任务 WebView 窗口按钮 */
  showOpenWebview?: boolean;
}

const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
  taskName: undefined,
  showStopTask: true,
  showOpenWebview: false,
});

const emit = defineEmits<{
  refresh: [];
  'stop-task': [];
  'delete-task': [];
  'add-to-album': [];
  'view-task-log': [];
  'view-task-params': [];
  'open-task-webview': [];
  'failed-images': [];
  back: [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const taskRouteStore = useTaskDetailRouteStore();
const pageBridge = usePageBridgeStore();

// Refresh 的入口在 header 上，这里额外注册桥接供全局快捷键（⇧⌘R）使用；
// ToggleShowHidden 的入口在全局工具箱，只有桥接。
onMounted(() => {
  pageBridge.setRefresh(() => emit("refresh"));
  pageBridge.setToggleShowHidden({
    get: () => taskRouteStore.hide,
    set: (v) => {
      taskRouteStore.hide = v;
    },
  });
});
onUnmounted(() => {
  pageBridge.setRefresh(null);
  pageBridge.setToggleShowHidden(null);
});

// 计算显示和折叠的feature ID
const showIds = computed(() => {
  if (isCompact.value) {
    return [HeaderFeatureId.Refresh, HeaderFeatureId.TaskDrawer];
  } else {
    const ids = [
      HeaderFeatureId.Refresh,
      HeaderFeatureId.DeleteTask,
      HeaderFeatureId.AddToAlbum,
      HeaderFeatureId.FailedImages,
      HeaderFeatureId.TaskDrawer,
      HeaderFeatureId.TaskViewLog,
      HeaderFeatureId.TaskViewParams,
    ];
    // StopTask 紧跟在 Refresh 之后
    if (props.showStopTask) ids.splice(1, 0, HeaderFeatureId.StopTask);
    if (props.showOpenWebview) ids.push(HeaderFeatureId.OpenTaskWebview);
    return ids;
  }
});

const foldIds = computed(() => {
  if (!isCompact.value) return [];
  const ids = [
    HeaderFeatureId.DeleteTask,
    HeaderFeatureId.AddToAlbum,
    HeaderFeatureId.FailedImages,
    HeaderFeatureId.TaskViewLog,
    HeaderFeatureId.TaskViewParams,
  ];
  if (props.showStopTask) ids.unshift(HeaderFeatureId.StopTask);
  if (props.showOpenWebview) ids.splice(props.showStopTask ? 3 : 2, 0, HeaderFeatureId.OpenTaskWebview);
  return ids;
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.Refresh:
      emit("refresh");
      break;
    case HeaderFeatureId.StopTask:
      emit("stop-task");
      break;
    case HeaderFeatureId.DeleteTask:
      emit("delete-task");
      break;
    case HeaderFeatureId.AddToAlbum:
      emit("add-to-album");
      break;
    case HeaderFeatureId.TaskViewLog:
      emit("view-task-log");
      break;
    case HeaderFeatureId.TaskViewParams:
      emit("view-task-params");
      break;
    case HeaderFeatureId.OpenTaskWebview:
      emit("open-task-webview");
      break;
    case HeaderFeatureId.FailedImages:
      // 桌面由 show 区的 FailedImagesHeaderButton comp 直接处理；
      // 紧凑模式走 fold 菜单 action，由父组件托管对话框
      emit("failed-images");
      break;
  }
};

// 处理返回
const handleBack = () => {
  emit("back");
};
</script>
