<template>
  <!-- 紧凑单行：自动配置卡片侧栏、重试记录弹出层 -->
  <div
    v-if="layout === 'inline'"
    class="task-summary-row box-border flex w-full min-w-[min(100%,360px)] flex-col gap-1.5 rounded-kb-md border border-solid border-kb-line bg-kb-surface-raised px-2.5 py-2"
  >
    <div class="flex w-full min-w-0 items-center gap-2">
      <div class="min-w-0 flex-1 overflow-hidden">
        <!-- content 为空时不弹 -->
        <Tooltip :content="tooltipContent" side="top" multiline>
          <div class="flex w-full min-w-0 items-center gap-2 overflow-hidden">
            <span class="min-w-0 max-w-full flex-[1_1_120px] truncate text-[13px] font-500 text-kb-fg">
              {{ pluginDisplayName }}
            </span>
            <div class="inline-flex flex-none items-center text-[12px] leading-none tabular-nums" @click.stop>
              <span
                v-if="task.isDryRun"
                :class="['text-kb-fg-subtle', { 'opacity-40': dedupN === 0 }]"
                :title="t('tasks.dryRunSkippedCount', { n: dedupN })"
              >
                {{ dedupN }}
              </span>
              <template v-else>
                <template v-for="(stat, index) in inlineStats" :key="stat.key">
                  <span v-if="index > 0" class="select-none px-[3px] text-kb-fg-subtle" aria-hidden="true">/</span>
                  <span :class="[stat.tone, { 'opacity-40': stat.n === 0 }]" :title="stat.title">{{ stat.n }}</span>
                </template>
              </template>
            </div>
          </div>
        </Tooltip>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <TaskRetryChainPopover
          v-if="retryChain && retryCountN > 0"
          :root-id="retryRootId"
          :current-id="task.id"
          @open-task-images="emit('open-task-images', $event)"
          @open-task-log="emit('open-task-log', $event)"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            :title="t('tasks.retryChainTitle')"
            :aria-label="t('tasks.retryChainTitle')"
          >
            <History />
          </Button>
        </TaskRetryChainPopover>
        <Button
          v-if="showRunParamsButton"
          variant="ghost"
          size="icon-sm"
          :title="t('tasks.openRunParams')"
          :aria-label="t('tasks.openRunParams')"
          @click.stop="emit('open-run-params')"
        >
          <Info />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :title="t('tasks.drawerViewImages')"
          :aria-label="t('tasks.drawerViewImages')"
          @click.stop="emit('open-task-images', task.id)"
        >
          <ImageIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          :title="t('tasks.drawerViewLog')"
          :aria-label="t('tasks.drawerViewLog')"
          @click.stop="emit('open-task-log', task.id)"
        >
          <FileText />
        </Button>
        <Tag v-if="showStatusTag" :tone="statusTone(task.status)" size="sm" class="ml-1">
          {{ statusLabel(task.status) }}
        </Tag>
      </div>
    </div>
    <Progress v-if="shouldShowInlineProgressBar" :value="inlineProgressPercent" :tone="progressTone" :height="3" />
  </div>

  <!-- 任务抽屉条目头部：双行 + 可选定时按钮 -->
  <div v-else class="task-summary-row flex items-start justify-between gap-2">
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <div class="flex min-w-0 items-center gap-1.5">
        <Button
          v-if="showScheduleButton"
          variant="ghost"
          size="icon-xs"
          :aria-label="scheduledTaskAriaLabel"
          :title="scheduledTaskAriaLabel"
          @click.stop="emit('open-schedule-config', task)"
        >
          <AlarmClock />
        </Button>
        <div class="min-w-0 truncate text-[14px] font-500 text-kb-fg">{{ pluginDisplayName }}</div>
        <Tag v-if="task.isDryRun" tone="warning" size="sm">{{ t("tasks.dryRunBadge") }}</Tag>
        <template v-if="retryCountN > 0">
          <TaskRetryChainPopover
            v-if="retryChain"
            :root-id="retryRootId"
            :current-id="task.id"
            @open-task-images="emit('open-task-images', $event)"
            @open-task-log="emit('open-task-log', $event)"
          >
            <button
              type="button"
              class="inline-flex cursor-pointer rounded-kb-sm border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-kb-ring"
              :title="t('tasks.retryChainTitle')"
            >
              <Tag size="sm">
                <template #icon><History /></template>
                {{ retryBadge }}
              </Tag>
            </button>
          </TaskRetryChainPopover>
          <Tag v-else size="sm">{{ retryBadge }}</Tag>
        </template>
      </div>
      <TaskCountsInline
        :success="successN"
        :failed="failedN"
        :deleted="deletedN"
        :dedup="dedupN"
        :dry-run="task.isDryRun"
      />
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-1">
      <Button
        v-if="showRunParamsButton"
        variant="ghost"
        size="icon-sm"
        :title="t('tasks.openRunParams')"
        :aria-label="t('tasks.openRunParams')"
        @click.stop="emit('open-run-params')"
      >
        <Info />
      </Button>
      <Button
        v-if="!stackedOmitImageLogActions"
        variant="ghost"
        size="icon-sm"
        :title="t('tasks.drawerViewImages')"
        :aria-label="t('tasks.drawerViewImages')"
        @click.stop="emit('open-task-images', task.id)"
      >
        <ImageIcon />
      </Button>
      <Button
        v-if="!stackedOmitImageLogActions"
        variant="ghost"
        size="icon-sm"
        :title="t('tasks.drawerViewLog')"
        :aria-label="t('tasks.drawerViewLog')"
        @click.stop="emit('open-task-log', task.id)"
      >
        <FileText />
      </Button>
      <Tag v-if="showStatusTag" :tone="statusTone(task.status)" size="sm">{{ statusLabel(task.status) }}</Tag>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { useI18n } from "@kabegame/i18n";
import { AlarmClock, FileText, History, Image as ImageIcon, Info } from "@lucide/vue";
import { usePluginStore } from "../../stores/plugins";
import Button from "@/components/ui/Button.vue";
import Progress from "@/components/ui/Progress.vue";
import Tag from "@/components/ui/Tag.vue";
import Tooltip from "@/components/ui/Tooltip.vue";
import TaskCountsInline from "./TaskCountsInline.vue";

// 弹出层里也渲染任务行：异步引入，避免两个组件互相 import
const TaskRetryChainPopover = defineAsyncComponent(() => import("./TaskRetryChainPopover.vue"));

/** 与 CrawlTask / 抽屉 ScriptTask 共用的最小字段 */
export type TaskSummaryRowTask = {
  id: string;
  pluginId: string;
  runConfigId?: string;
  triggerSource?: string;
  isDryRun: boolean;
  /** 失败重试次数；> 0 才显示重试徽标与「重试记录」入口 */
  retryCount?: number;
  retryAttempt?: number;
  /** 重试链原始任务 id；缺省为自身 id */
  retryRootId?: string;
  status: string;
  progress?: number;
  deletedCount?: number;
  dedupCount?: number;
  successCount?: number;
  failedCount?: number;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

const props = withDefaults(
  defineProps<{
    task: TaskSummaryRowTask;
    /** inline：自动配置侧栏单行；stacked：任务抽屉 */
    layout: "inline" | "stacked";
    showScheduleButton?: boolean;
    scheduledTaskAriaLabel?: string;
    showStatusTag?: boolean;
    /** 自动配置：悬停展示完整任务信息 */
    tooltipContent?: string;
    /** 打开「运行参数」弹窗的按钮（任务抽屉 / 自动配置列表） */
    showRunParamsButton?: boolean;
    /** 任务抽屉：图片/日志改由外侧文字按钮触发，隐藏本行图标按钮 */
    stackedOmitImageLogActions?: boolean;
    /** 可点开「重试记录」弹出层；弹出层里的行传 false，避免嵌套 */
    retryChain?: boolean;
  }>(),
  {
    showScheduleButton: false,
    scheduledTaskAriaLabel: "",
    showStatusTag: true,
    tooltipContent: "",
    showRunParamsButton: false,
    stackedOmitImageLogActions: false,
    retryChain: true,
  },
);

const emit = defineEmits<{
  (e: "open-task-images", taskId: string): void;
  (e: "open-task-log", taskId: string): void;
  (e: "open-schedule-config", task: TaskSummaryRowTask): void;
  (e: "open-run-params"): void;
}>();

const { t } = useI18n();
const pluginStore = usePluginStore();

const pluginDisplayName = computed(() => pluginStore.pluginLabel(props.task.pluginId));

const successN = computed(() => Number(props.task.successCount ?? 0));
const failedN = computed(() => Number(props.task.failedCount ?? 0));
const deletedN = computed(() => Number(props.task.deletedCount ?? 0));
const dedupN = computed(() => Number(props.task.dedupCount ?? 0));
const retryCountN = computed(() => Number(props.task.retryCount ?? 0));
const retryRootId = computed(() => props.task.retryRootId || props.task.id);
const retryBadge = computed(() =>
  t("tasks.retryBadge", { k: Number(props.task.retryAttempt ?? 0), n: retryCountN.value }),
);

function isCanceledTaskStatus(s: string): boolean {
  return s === "canceled" || s === "cancelled";
}

/** 与 TaskDrawerContent 一致：running / failed / canceled 且 progress>0 */
const shouldShowInlineProgressBar = computed(() => {
  const p = Number(props.task.progress ?? 0);
  if (!Number.isFinite(p) || p <= 0) return false;
  const s = props.task.status;
  return s === "running" || s === "waiting_downloads" || s === "failed" || isCanceledTaskStatus(s);
});

const inlineProgressPercent = computed(() => {
  const p = Number(props.task.progress ?? 0);
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(100, Math.max(0, p)));
});

const progressTone = computed(() => {
  const s = props.task.status;
  if (s === "failed") return "danger";
  if (isCanceledTaskStatus(s)) return "muted";
  return "accent";
});

/** 单行布局的四项计数：成功 / 失败 / 已删除 / 去重，以「/」隔开 */
const inlineStats = computed(() => [
  { key: "success", n: successN.value, tone: "text-kb-success", title: t("tasks.totalCount", { n: successN.value }) },
  { key: "failed", n: failedN.value, tone: "text-kb-danger", title: t("tasks.failedCount", { n: failedN.value }) },
  {
    key: "deleted",
    n: deletedN.value,
    tone: "text-kb-fg-muted",
    title: t("tasks.deletedCount", { n: deletedN.value }),
  },
  { key: "dedup", n: dedupN.value, tone: "text-kb-fg-subtle", title: t("tasks.dedupCount", { n: dedupN.value }) },
]);

type StatusTone = "neutral" | "accent" | "success" | "danger";

/** 状态色：运行中强调色、完成成功色、失败危险色，其余中性 */
function statusTone(s: string): StatusTone {
  const map: Record<string, StatusTone> = {
    running: "accent",
    waiting_downloads: "accent",
    completed: "success",
    failed: "danger",
  };
  return map[s] ?? "neutral";
}

function statusLabel(s: string): string {
  const keyMap: Record<string, string> = {
    pending: "tasks.drawerTaskStatusPending",
    running: "tasks.drawerTaskStatusRunning",
    waiting_downloads: "tasks.drawerTaskStatusWaitingDownloads",
    completed: "tasks.drawerTaskStatusCompleted",
    failed: "tasks.drawerTaskStatusFailed",
    canceled: "tasks.drawerTaskStatusCanceled",
  };
  const key = keyMap[s];
  return key ? t(key) : s;
}
</script>
