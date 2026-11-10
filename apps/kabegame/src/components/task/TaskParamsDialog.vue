<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="t('tasks.taskRunParamsTitle')"
    width="580px"
    :append-to-body="true"
    class="task-params-dialog"
    destroy-on-close
    @update:model-value="
      (v: boolean) => {
        if (!v) emit('close');
      }
    "
    @closed="emit('closed')"
  >
    <TaskRunParamsContent v-if="task" :key="task.id" :task="task" @open-task="openTask" />
  </el-dialog>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { useRoute, useRouter } from "vue-router";
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
const route = useRoute();
const router = useRouter();

function openTask(taskId: string) {
  emit("close");
  const target = { name: "TaskDetail", params: { taskId } };
  if (route.name === "TaskDetail") void router.replace(target);
  else void router.push(target);
}
</script>
