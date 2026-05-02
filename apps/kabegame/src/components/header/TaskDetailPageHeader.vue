<template>
  <PageHeader
    :title="taskName || t('tasks.task')"
    :subtitle="taskSubtitle"
    :show="showIds"
    :fold="foldIds"
    @action="handleAction"
    show-back
    @back="handleBack"
  />
</template>

<script setup lang="ts">
import { computed, onUnmounted, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { HeaderFeatureId, useHeaderStore } from "@kabegame/core/stores/header";
import { useUiStore } from "@kabegame/core/stores/ui";
import { storeToRefs } from "pinia";
import { useTaskDetailRouteStore } from "@/stores/taskDetailRoute";

interface Props {
  taskName?: string;
  taskSubtitle?: string;
  /** 是否显示停止任务（仅当任务 running 时为 true，用于控制 Android fold 中是否显示停止） */
  showStopTask?: boolean;
}

const { t } = useI18n();

const props = withDefaults(defineProps<Props>(), {
  taskName: undefined,
  taskSubtitle: undefined,
  showStopTask: true,
});

const emit = defineEmits<{
  refresh: [];
  'stop-task': [];
  'delete-task': [];
  'add-to-album': [];
  help: [];
  'quick-settings': [];
  'view-task-log': [];
  'view-task-params': [];
  back: [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const taskRouteStore = useTaskDetailRouteStore();
const { hide: taskHide } = storeToRefs(taskRouteStore);
const headerStore = useHeaderStore();

watch(
  taskHide,
  () => {
    headerStore.setFoldLabel(
      HeaderFeatureId.ToggleShowHidden,
      taskHide.value ? t("header.showHidden") : t("header.hideHidden"),
    );
  },
  { immediate: true },
);
onUnmounted(() => {
  headerStore.setFoldLabel(HeaderFeatureId.ToggleShowHidden, undefined);
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
      HeaderFeatureId.TaskDrawer,
      HeaderFeatureId.TaskViewLog,
      HeaderFeatureId.TaskViewParams,
      HeaderFeatureId.Help,
      HeaderFeatureId.QuickSettings,
    ];
    if (props.showStopTask) ids.splice(1, 0, HeaderFeatureId.StopTask);
    return ids;
  }
});

const foldIds = computed(() => {
  if (!isCompact.value) return [HeaderFeatureId.ToggleShowHidden];
  const ids = [
    HeaderFeatureId.DeleteTask,
    HeaderFeatureId.AddToAlbum,
    HeaderFeatureId.TaskViewLog,
    HeaderFeatureId.TaskViewParams,
    HeaderFeatureId.Help,
    HeaderFeatureId.QuickSettings,
    HeaderFeatureId.ToggleShowHidden,
  ];
  if (props.showStopTask) ids.unshift(HeaderFeatureId.StopTask);
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
    case HeaderFeatureId.Help:
      emit("help");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("quick-settings");
      break;
    case HeaderFeatureId.TaskViewLog:
      emit("view-task-log");
      break;
    case HeaderFeatureId.TaskViewParams:
      emit("view-task-params");
      break;
    case HeaderFeatureId.ToggleShowHidden:
      taskRouteStore.hide = !taskRouteStore.hide;
      break;
  }
};

// 处理返回
const handleBack = () => {
  emit("back");
};
</script>