<template>
  <!-- 首屏在途：先留白，超过延迟才转圈，快速返回时不闪「暂无」 -->
  <div v-if="tasks.length === 0 && loading" v-loading="showLoading" class="h-10" />
  <span v-else-if="tasks.length === 0" class="text-[12px] text-kb-fg-muted">{{ t("autoConfig.noRelatedTasks") }}</span>
  <template v-else>
    <div v-bind="containerProps" class="h-40 w-full overflow-x-auto" @scroll="handleScroll">
      <div v-bind="wrapperProps">
        <div v-for="item in virtualList" :key="item.data.id" class="box-border h-[60px] shrink-0 overflow-hidden">
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
      :open="runParamsOpen"
      :task="runParamsTask"
      @close="runParamsOpen = false"
      @closed="runParamsTask = null"
    />
  </template>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import TaskSummaryRow from "@/components/task/TaskSummaryRow.vue";
import TaskParamsDialog from "@/components/task/TaskParamsDialog.vue";
import type { CrawlTask } from "@/stores/crawler";
import { usePagedTaskList } from "@/composables/usePagedTaskList";
import { encodeSeg } from "@kabegame/pathql-client";
import { vLoading } from "@/components/ui/loading";

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

const runParamsOpen = ref(false);
const runParamsTask = ref<CrawlTask | null>(null);

function openRunParams(task: CrawlTask) {
  runParamsTask.value = task;
  runParamsOpen.value = true;
}

function handleScroll(event: Event) {
  const element = event.target as HTMLElement;
  if (loading.value || !hasMore.value) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 40) void loadMore();
}
</script>
