<template>
  <el-popover
    v-model:visible="visible"
    :width="520"
    trigger="click"
    placement="bottom-start"
    :popper-style="{ zIndex: layer.zIndex.value }"
  >
    <template #reference>
      <span class="inline-flex flex-none" @click.stop><slot /></span>
    </template>
    <div class="flex flex-col gap-2" @click.stop>
      <div class="text-sm font-medium">{{ t("tasks.retryChainTitle") }}</div>
      <!-- 首屏在途：先留白，超过延迟才转圈 -->
      <div v-if="slots.length === 0 && loading" v-loading="showLoading" class="h-10" />
      <div v-else class="max-h-[360px] overflow-y-auto">
        <div
          v-for="slot in slots"
          :key="slot.task ? slot.task.id : `deleted-${slot.attempt}`"
          class="retry-chain-row flex min-h-[60px] items-center gap-2 rounded px-1"
          :class="{ 'retry-chain-row--current': slot.task?.id === currentId }"
        >
          <span class="w-14 flex-none text-xs text-[var(--anime-text-secondary)]">
            {{ slot.attempt === 0 ? t("tasks.retryChainOriginal") : t("tasks.retryChainAttempt", { k: slot.attempt }) }}
          </span>
          <TaskSummaryRow
            v-if="slot.task"
            class="min-w-0 flex-1"
            :task="slot.task"
            layout="inline"
            show-status-tag
            show-run-params-button
            :retry-chain="false"
            @open-run-params="openRunParams(slot.task)"
            @open-task-images="forward('open-task-images', $event)"
            @open-task-log="forward('open-task-log', $event)"
          />
          <span v-else class="flex-1 text-xs text-[var(--anime-text-secondary)]">
            {{ t("tasks.retryChainDeleted") }}
          </span>
        </div>
      </div>
    </div>
  </el-popover>
  <TaskParamsDialog
    :open="runParamsDialog.isOpen.value"
    :z-index="runParamsDialog.zIndex.value"
    :task="runParamsTask"
    @close="runParamsDialog.close()"
    @closed="runParamsTask = null"
  />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import TaskSummaryRow from "./TaskSummaryRow.vue";
import TaskParamsDialog from "./TaskParamsDialog.vue";
import { useModal } from "@/composables/useModal";
import { useLoadingDelay } from "@/composables/useLoadingDelay";
import { useRetryChainTasks } from "@/composables/useRetryChainTasks";
import type { CrawlTask } from "@/stores/crawler";

const props = defineProps<{
  /** 重试链的原始任务 id */
  rootId: string;
  /** 从哪个任务打开：列表里高亮它 */
  currentId: string;
}>();

const emit = defineEmits<{
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
}>();

const { t } = useI18n();
const visible = ref(false);
// 弹出层常在弹窗里（运行配置详情、任务抽屉）打开：在模态栈占一层取 z-index，否则会被弹窗盖住；
// 同一个栈位也让 Android 返回键先关掉它
const layer = useModal({ onClose: () => (visible.value = false) });
watch(visible, (open) => (open ? layer.open() : layer.close()));

// 只在打开期间观察这条链，关闭即停止观察、不随事件刷新
const { slots, loading } = useRetryChainTasks(() => (visible.value ? props.rootId : null));
const { showLoading, startLoading, finishLoading } = useLoadingDelay();
watch(loading, (on) => (on ? startLoading() : finishLoading()), { flush: "sync" });

const runParamsDialog = useModal();
const runParamsTask = ref<CrawlTask | null>(null);

function openRunParams(task: CrawlTask) {
  runParamsTask.value = task;
  runParamsDialog.open();
}

function forward(event: "open-task-images" | "open-task-log", taskId: string) {
  visible.value = false;
  if (event === "open-task-images") emit("open-task-images", taskId);
  else emit("open-task-log", taskId);
}
</script>

<style scoped lang="scss">
.retry-chain-row--current {
  background: var(--el-fill-color-light);
}
</style>
