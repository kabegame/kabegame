<template>
  <!-- 首屏在途：先留白，超过延迟才转圈，快速返回时不闪「暂无」 -->
  <div v-if="tasks.length === 0 && loading" v-loading="showLoading" class="h-10" />
  <span v-else-if="tasks.length === 0" class="config-no-tasks">{{ t("autoConfig.noRelatedTasks") }}</span>
  <template v-else>
    <div
      v-bind="containerProps"
      class="config-tasks-scroll config-tasks-scroll--virtual config-tasks-scroll--virtual--desktop"
      @scroll="handleScroll"
    >
      <div v-bind="wrapperProps">
        <div v-for="item in virtualList" :key="item.data.id" class="config-task-virtual-item">
          <TaskSummaryRow
            :task="item.data"
            layout="inline"
            show-status-tag
            show-run-params-button
            @open-run-params="openRunParams(item.data)"
            @open-task-images="emit('open-task-images', $event)"
            @open-task-log="emit('open-task-log', $event)"
          />
        </div>
      </div>
    </div>
    <TaskParamsDialog
      :open="runParamsDialog.isOpen.value"
      :z-index="runParamsDialog.zIndex.value"
      :task="runParamsTask"
      @close="runParamsDialog.close()"
      @closed="runParamsTask = null"
    />
  </template>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useModal } from "@/composables/useModal";
import { useVirtualList } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import TaskSummaryRow from "@/components/task/TaskSummaryRow.vue";
import TaskParamsDialog from "@/components/task/TaskParamsDialog.vue";
import type { CrawlTask } from "@/stores/crawler";
import { usePagedTaskList } from "@/composables/usePagedTaskList";
import { encodeSeg } from "@kabegame/pathql-client";

const props = defineProps<{ configId: string }>();

const emit = defineEmits<{
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
}>();

const { t } = useI18n();
const {
  items: tasks,
  hasMore,
  loading,
  showLoading,
  start,
  loadMore,
} = usePagedTaskList({
  basePath: () => `run_config/${encodeSeg(props.configId)}/`,
});
onMounted(() => void start());

/** 单行 TaskSummaryRow（inline + 多枚操作图标 + 状态 tag）固定高度，须与 itemHeight 一致 */
const RELATED_TASK_ROW_PX = 60;

const {
  list: virtualList,
  containerProps,
  wrapperProps,
} = useVirtualList(tasks, {
  itemHeight: RELATED_TASK_ROW_PX,
  overscan: 6,
});

const runParamsDialog = useModal();
const runParamsTask = ref<CrawlTask | null>(null);

function openRunParams(task: CrawlTask) {
  runParamsTask.value = task;
  runParamsDialog.open();
}

function handleScroll(event: Event) {
  const element = event.target as HTMLElement;
  if (loading.value || !hasMore.value) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 40) void loadMore();
}
</script>

<style scoped lang="scss">
.config-no-tasks {
  font-size: 12px;
  color: var(--anime-text-secondary);
}

.config-tasks-scroll--virtual {
  width: 100%;
  overflow-x: auto;
}

.config-tasks-scroll--virtual--desktop {
  height: 160px;
  max-height: 160px;
}

.config-task-virtual-item {
  height: 60px;
  box-sizing: border-box;
  flex-shrink: 0;
  overflow: hidden;
}
</style>
