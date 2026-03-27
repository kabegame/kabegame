<template>
  <el-dialog
    v-model="visible"
    :title="t('tasks.taskRunParamsTitle')"
    width="580px"
    :append-to-body="true"
    class="task-params-dialog"
    destroy-on-close
    @closed="emit('closed')"
  >
    <TaskRunParamsContent v-if="task" :key="task.id" :task="task" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "../../composables/useModalBack";
import TaskRunParamsContent from "./TaskRunParamsContent.vue";
import type { TaskRunParamsTask } from "./TaskRunParamsContent.vue";

const props = defineProps<{
  modelValue: boolean;
  task: TaskRunParamsTask | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "closed"): void;
}>();

const { t } = useI18n();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

useModalBack(visible);
</script>
