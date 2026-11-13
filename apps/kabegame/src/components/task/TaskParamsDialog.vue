<template>
  <Dialog
    :open="open"
    :title="t('tasks.taskRunParamsTitle')"
    :width="580"
    @update:open="(v: boolean) => !v && emit('close')"
    @close-auto-focus="emit('closed')"
  >
    <!-- 内容随任务换 key 重建：切换任务时滚动位置从头开始 -->
    <TaskRunParamsContent v-if="task" :key="task.id" :task="task" @open-task="openTask" />
  </Dialog>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { useRoute, useRouter } from "vue-router";
import Dialog from "@/components/ui/Dialog.vue";
import TaskRunParamsContent from "./TaskRunParamsContent.vue";
import type { TaskRunParamsTask } from "./TaskRunParamsContent.vue";

defineProps<{
  open: boolean;
  task: TaskRunParamsTask | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  /** 关闭动画结束、内容卸载后 */
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
