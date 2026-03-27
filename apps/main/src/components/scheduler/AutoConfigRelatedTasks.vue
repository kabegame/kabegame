<template>
  <span v-if="tasks.length === 0" class="config-no-tasks">{{ t("autoConfig.noRelatedTasks") }}</span>
  <template v-else>
    <div v-bind="containerProps" class="config-tasks-scroll config-tasks-scroll--virtual">
      <div v-bind="wrapperProps">
        <div
          v-for="item in virtualList"
          :key="item.data.id"
          class="config-task-virtual-item"
        >
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
      v-model="runParamsDialogOpen"
      :task="runParamsTask"
      @closed="runParamsTask = null"
    />
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { useCrawlerStore } from "@/stores/crawler";
import TaskSummaryRow from "@kabegame/core/components/task/TaskSummaryRow.vue";
import TaskParamsDialog from "@kabegame/core/components/task/TaskParamsDialog.vue";
import type { CrawlTask } from "@kabegame/core/stores/crawler";

const props = defineProps<{
  configId: string;
}>();

const emit = defineEmits<{
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
}>();

const { t } = useI18n();
const crawlerStore = useCrawlerStore();

const tasks = computed(() => {
  const id = props.configId;
  const list: CrawlTask[] = [];
  for (const task of crawlerStore.tasks) {
    if (task.runConfigId === id) list.push(task);
  }
  list.sort((a, b) => {
    const ta = Number(a.startTime ?? a.endTime ?? 0);
    const tb = Number(b.startTime ?? b.endTime ?? 0);
    return tb - ta;
  });
  return list;
});

/** 单行 TaskSummaryRow（inline + 多枚操作图标 + 状态 tag）固定高度，须与 itemHeight 一致 */
const RELATED_TASK_ROW_PX = 60;

const { list: virtualList, containerProps, wrapperProps } = useVirtualList(tasks, {
  itemHeight: RELATED_TASK_ROW_PX,
  overscan: 6,
});

const runParamsDialogOpen = ref(false);
const runParamsTask = ref<CrawlTask | null>(null);

function openRunParams(task: CrawlTask) {
  runParamsTask.value = task;
  runParamsDialogOpen.value = true;
}
</script>

<style scoped lang="scss">
.config-no-tasks {
  font-size: 12px;
  color: var(--anime-text-secondary);
}

.config-tasks-scroll--virtual {
  width: 100%;
  height: 200px;
  max-height: 200px;
  overflow-x: auto;
}

.config-task-virtual-item {
  height: 60px;
  box-sizing: border-box;
  flex-shrink: 0;
  overflow: hidden;
}

@media (min-width: 1024px) {
  .config-tasks-scroll--virtual {
    height: 160px;
    max-height: 160px;
  }
}
</style>
