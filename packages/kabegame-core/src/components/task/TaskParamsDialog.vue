<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('tasks.taskRunParamsTitle')"
    width="580px"
    :append-to-body="true"
    class="task-params-dialog"
    destroy-on-close
    @update:model-value="(v: boolean) => { if (!v) emit('close') }"
    @closed="emit('closed')"
  >
    <TaskRunParamsContent v-if="task" :key="task.id" :task="task" />
  </el-dialog>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import TaskRunParamsContent from "./TaskRunParamsContent.vue";
import type { TaskRunParamsTask } from "./TaskRunParamsContent.vue";

defineProps<{
  open: boolean;
  zIndex: number;
  task: TaskRunParamsTask | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "closed"): void;
}>();

const { t } = useI18n();
</script>
