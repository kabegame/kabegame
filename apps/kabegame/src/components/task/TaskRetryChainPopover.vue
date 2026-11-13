<template>
  <Popover v-model:open="visible">
    <!-- 包一层拦住点击：任务行 / 卡片自身可能有点击处理 -->
    <span class="inline-flex flex-none" @click.stop>
      <PopoverTrigger as-child><slot /></PopoverTrigger>
    </span>
    <PopoverContent side="bottom" align="start" :width="520">
      <div class="flex flex-col gap-2 p-1" @click.stop>
        <div class="text-[13px] font-600 text-kb-fg">{{ t("tasks.retryChainTitle") }}</div>
        <!-- 首屏在途：先留白，超过延迟才转圈 -->
        <div v-if="slots.length === 0 && loading" class="grid h-10 place-items-center text-kb-fg-subtle">
          <Spinner v-if="showLoading" :size="16" />
        </div>
        <div v-else class="flex max-h-[360px] flex-col gap-1 overflow-y-auto">
          <div
            v-for="slot in slots"
            :key="slot.task ? slot.task.id : `deleted-${slot.attempt}`"
            class="flex min-h-[60px] items-center gap-2 rounded-kb-md px-1.5"
            :class="slot.task?.id === currentId ? 'bg-kb-fill-light' : ''"
          >
            <span class="w-14 flex-none text-[12px] text-kb-fg-muted">
              {{
                slot.attempt === 0 ? t("tasks.retryChainOriginal") : t("tasks.retryChainAttempt", { k: slot.attempt })
              }}
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
            <span v-else class="flex-1 text-[12px] text-kb-fg-subtle">
              {{ t("tasks.retryChainDeleted") }}
            </span>
          </div>
        </div>
      </div>
    </PopoverContent>
  </Popover>
  <TaskParamsDialog
    :open="runParamsOpen"
    :task="runParamsTask"
    @close="runParamsOpen = false"
    @closed="runParamsTask = null"
  />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import TaskSummaryRow from "./TaskSummaryRow.vue";
import TaskParamsDialog from "./TaskParamsDialog.vue";
import { PopoverTrigger } from "reka-ui";
import Popover from "@/components/ui/Popover.vue";
import PopoverContent from "@/components/ui/PopoverContent.vue";
import Spinner from "@/components/ui/Spinner.vue";
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
// 弹出层常在弹窗里（运行配置详情、任务抽屉）打开：层级由 PopoverContent 打开时取号，Android 返回键由 Popover 接
const visible = ref(false);

// 只在打开期间观察这条链，关闭即停止观察、不随事件刷新
const { slots, loading } = useRetryChainTasks(() => (visible.value ? props.rootId : null));
const { showLoading, startLoading, finishLoading } = useLoadingDelay();
watch(loading, (on) => (on ? startLoading() : finishLoading()), { flush: "sync" });

const runParamsOpen = ref(false);
const runParamsTask = ref<CrawlTask | null>(null);

function openRunParams(task: CrawlTask) {
  runParamsTask.value = task;
  runParamsOpen.value = true;
}

function forward(event: "open-task-images" | "open-task-log", taskId: string) {
  visible.value = false;
  if (event === "open-task-images") emit("open-task-images", taskId);
  else emit("open-task-log", taskId);
}
</script>
