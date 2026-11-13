<template>
  <Dialog
    v-model:open="visible"
    :width="isCompact ? '95vw' : 760"
    body-class="flex min-h-0 flex-col gap-3 px-5 pb-4 pt-2"
  >
    <template #title>
      <span class="inline-flex items-center gap-2">
        {{ dialogTitle }}
        <Tag size="sm">{{ filteredFailed.length }}</Tag>
      </span>
    </template>

    <!-- 工具条：来源过滤 + 批量操作 -->
    <div v-if="baseList.length > 0" class="flex flex-wrap items-center gap-2">
      <DropdownMenu v-if="pluginGroups.length > 1">
        <DropdownMenuTrigger as-child>
          <Button size="sm">
            {{ pluginFilterLabel }}
            <ChevronDown class="opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <MenuItem @select="filterPluginId = null">{{ t("gallery.filterAll") }}</MenuItem>
          <MenuItem v-for="g in pluginGroups" :key="g.pluginId" @select="filterPluginId = g.pluginId || null">
            <span class="min-w-0 flex-1 truncate">{{ getFailedPluginName(g.pluginId) }}</span>
            <span class="ml-3 text-[12px] tabular-nums text-kb-fg-subtle">{{ g.count }}</span>
          </MenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span class="flex-1" />
      <Button v-if="hasPendingInFilter" size="sm" @click="handleCancelAll">
        <CircleX />
        {{ t("header.failedImagesCancelWaiting") }}
      </Button>
      <Button v-if="hasIdleInFilter" size="sm" variant="primary" :disabled="bulkRetryLoading" @click="handleRetryAll">
        <Spinner v-if="bulkRetryLoading" :size="14" />
        <RotateCw v-else />
        {{ t("header.failedImagesRetryAll") }}
      </Button>
      <Button
        v-if="hasIdleInFilter"
        size="sm"
        variant="ghost-danger"
        :disabled="bulkDeleteLoading"
        @click="handleDeleteAll"
      >
        <Spinner v-if="bulkDeleteLoading" :size="14" />
        <Trash2 v-else />
        {{ t("header.failedImagesDeleteAll") }}
      </Button>
    </div>

    <div v-if="loading" class="flex flex-col gap-2.5">
      <Skeleton v-for="i in 4" :key="i" class="h-[118px]" />
    </div>
    <Empty v-else-if="baseList.length === 0" :description="t('tasks.allFailedImagesEmpty')">
      <template #icon><CircleCheck /></template>
    </Empty>
    <Empty v-else-if="filteredFailed.length === 0" :description="t('tasks.failedFilterEmpty')">
      <template #icon><Funnel /></template>
    </Empty>
    <div v-else v-bind="containerProps" class="h-[min(480px,60vh)] overflow-y-auto">
      <div v-bind="wrapperProps">
        <div v-for="{ data: failed } in virtualList" :key="failed.id" class="box-border h-[140px] pb-2.5">
          <div
            class="relative box-border flex h-full gap-3 overflow-hidden rounded-kb-lg border border-solid border-kb-line bg-kb-surface-raised px-3 py-2.5"
          >
            <!-- 缩略图：点开放大看（失败图多半加载不出来，所以只是个占位 + 看图入口） -->
            <button
              type="button"
              class="relative grid h-full w-20 shrink-0 cursor-zoom-in place-items-center overflow-hidden rounded-kb-md border-0 bg-kb-fill p-0 text-kb-fg-subtle"
              :aria-label="t('gallery.zoomIn')"
              @click="previewUrl = failed.url"
            >
              <ImageOff v-if="thumbState[failed.id] === 'error'" class="size-5" />
              <Spinner v-else-if="thumbState[failed.id] !== 'loaded'" :size="16" class="absolute" />
              <img
                v-show="thumbState[failed.id] !== 'error'"
                :src="failed.url"
                alt=""
                loading="lazy"
                class="size-full object-contain"
                @load="thumbState[failed.id] = 'loaded'"
                @error="thumbState[failed.id] = 'error'"
              />
            </button>

            <div class="flex min-w-0 flex-1 flex-col justify-between gap-1">
              <div class="flex items-center justify-between gap-1.5">
                <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Tag size="sm">{{ getFailedPluginName(failed.pluginId) }}</Tag>
                  <Tag v-if="itemStateTag(failed)" size="sm" :tone="itemStateTagTone(failed)">
                    {{ itemStateTag(failed) }}
                  </Tag>
                  <span class="whitespace-nowrap text-[11.5px] text-kb-fg-subtle">
                    {{ formatFailedTime(failed.createdAt) }}
                  </span>
                </div>
                <Button size="sm" variant="ghost" class="shrink-0" @click="openTaskDetail(failed.taskId)">
                  {{ t("tasks.viewTask") }}
                  <ArrowUpRight />
                </Button>
              </div>

              <a
                class="block truncate text-[11.5px] text-kb-fg-muted no-underline hover:text-kb-fg hover:underline"
                :href="failed.url"
                target="_blank"
                rel="noopener"
                :title="failed.url"
                @click.prevent="openFailedUrl(failed.url)"
              >
                {{ failed.url }}
              </a>

              <div class="flex min-w-0 items-start gap-1.5">
                <TriangleAlert class="mt-px size-3.5 shrink-0 text-kb-danger" />
                <span class="line-clamp-2 min-w-0 flex-1 text-[12px] leading-[1.4] text-kb-fg-muted">
                  {{ failed.lastError || "-" }}
                </span>
                <Tooltip :content="t('tasks.copyErrorDetails')">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    :aria-label="t('tasks.copyErrorDetails')"
                    @click="copyFailedError(failed)"
                  >
                    <Copy />
                  </Button>
                </Tooltip>
              </div>

              <div class="flex flex-wrap gap-1.5">
                <template v-if="getItemState(failed).isActive && getItemState(failed).state === 'preparing'">
                  <Button size="sm" @click="handleCancelRetry(failed.id)">
                    {{ t("tasks.cancelRetry") }}
                  </Button>
                </template>
                <template v-else-if="!getItemState(failed).isActive">
                  <Button size="sm" variant="primary" @click="handleRetryFailedImage(failed)">
                    {{ t("tasks.retryDownload") }}
                  </Button>
                  <Button size="sm" variant="ghost-danger" @click="handleDeleteFailedImage(failed.id)">
                    {{ t("tasks.deleteFailedRecord") }}
                  </Button>
                </template>
              </div>
            </div>

            <!-- 下载进度：卡片底边一条 -->
            <div
              v-if="getItemState(failed).isActive && getItemState(failed).state !== 'waiting'"
              class="pointer-events-none absolute inset-x-0 bottom-0"
            >
              <Progress
                :value="getItemState(failed).progress ?? null"
                :height="3"
                class="!rounded-none !bg-transparent"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Dialog>

  <!-- 放大看图 -->
  <Dialog
    :open="previewUrl !== null"
    :width="'min(900px, 92vw)'"
    body-class="grid place-items-center p-3"
    @update:open="(v: boolean) => !v && (previewUrl = null)"
  >
    <template #title>
      <span class="block truncate text-[13px] font-500 text-kb-fg-muted">{{ previewUrl }}</span>
    </template>
    <img v-if="previewUrl" :src="previewUrl" alt="" class="max-h-[72vh] max-w-full rounded-kb-md object-contain" />
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useRouter } from "vue-router";
import { kameMessage } from "@/utils/kameMessage";
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleX,
  Copy,
  Funnel,
  ImageOff,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "@lucide/vue";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { useFailedImagesStore } from "@/stores/failedImages";
import { useDownloadStateStore } from "@/stores/downloadState";
import type { TaskFailedImage } from "@/types/image";
import { useUiStore } from "@/stores/ui";
import { openExternalLink } from "@/utils/openExternalLink";
import { messageBox } from "@/components/ui/messageBox";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Empty,
  MenuItem,
  Progress,
  Skeleton,
  Spinner,
  Tag,
  Tooltip,
} from "@/components/ui";

interface Props {
  modelValue?: boolean;
  taskId?: string;
}

interface Emits {
  (e: "update:modelValue", value: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const { t } = useI18n();
const router = useRouter();
const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const downloadStore = useDownloadStateStore();
const uiStore = useUiStore();

const isCompact = computed(() => uiStore.isCompact);

// 开关：v-model 与 ref.open() 两种打开方式；关掉时回写 v-model。层级与 Android 返回键由 Dialog 接。
const visible = ref(false);
watch(
  () => props.modelValue,
  (v) => {
    if (v !== undefined) visible.value = v;
  },
  { immediate: true },
);
watch(visible, (v) => {
  if (!v) emit("update:modelValue", false);
});

/** 缩略图加载状态（按失败记录 id）；放大看图的地址 */
const thumbState = reactive<Record<number, "loaded" | "error">>({});
const previewUrl = ref<string | null>(null);

const activeTaskId = ref<string | undefined>(undefined);
const effectiveTaskId = computed(() => activeTaskId.value ?? props.taskId);

const setTaskId = (taskId?: string) => {
  activeTaskId.value = taskId;
  filterPluginId.value = null;
};

// Imperative API used by refs; scope is set separately via setTaskId().
const open = () => {
  visible.value = true;
};

defineExpose({ open, setTaskId });

const filterPluginId = ref<string | null>(null);
const bulkRetryLoading = ref(false);
const bulkDeleteLoading = ref(false);

const allFailed = computed(() => failedImagesStore.allFailed);
const loading = computed(() => failedImagesStore.loading);

/** Source list: scoped to taskId (if provided), otherwise all failures */
const baseList = computed(() =>
  effectiveTaskId.value ? allFailed.value.filter((f) => f.taskId === effectiveTaskId.value) : allFailed.value,
);

const dialogTitle = computed(() => (effectiveTaskId.value ? t("tasks.failedImagesForTask") : t("header.failedImages")));

const pluginGroups = computed(() => {
  const map = new Map<string, number>();
  for (const item of baseList.value) {
    const id = item.pluginId || "";
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .filter(([, count]) => count > 0)
    .map(([pluginId, count]) => ({ pluginId, count }))
    .sort((a, b) => b.count - a.count);
});

const filteredFailed = computed(() => {
  const pid = filterPluginId.value;
  if (!pid) return baseList.value;
  return baseList.value.filter((item) => item.pluginId === pid);
});

const pluginFilterLabel = computed(() => {
  const pid = filterPluginId.value;
  if (!pid) return t("gallery.filterAll");
  return t("gallery.filterByPluginWithName", { name: pluginStore.pluginLabel(pid) });
});

const getItemState = (item: TaskFailedImage) => {
  const ds = downloadStore.getByFailedImageId(item.id);
  if (ds) return { isActive: true, state: ds.state, progress: ds.progress } as const;
  return { isActive: false } as const;
};

const itemStateTag = (item: TaskFailedImage) => {
  const s = getItemState(item);
  if (!s.isActive) return "";
  const labels: Record<string, string> = {
    preparing: t("tasks.drawerStatusPreparing"),
    downloading: t("tasks.drawerStatusDownloading"),
    processing: t("tasks.drawerStatusProcessing"),
    completed: t("tasks.drawerStatusCompleted"),
    failed: t("tasks.drawerStatusFailed"),
    canceled: t("tasks.drawerStatusCanceled"),
  };
  return labels[s.state] ?? s.state;
};

const itemStateTagTone = (item: TaskFailedImage): "neutral" | "warning" | "success" | "danger" => {
  const s = getItemState(item);
  if (!s.isActive) return "neutral";
  if (s.state === "failed") return "danger";
  if (s.state === "completed" || s.state === "processing") return "success";
  if (s.state === "downloading" || s.state === "preparing") return "warning";
  return "neutral";
};

const hasIdleInFilter = computed(() => filteredFailed.value.some((f) => !getItemState(f).isActive));
const hasPendingInFilter = computed(() =>
  filteredFailed.value.some((f) => downloadStore.getByFailedImageId(f.id)?.state === "preparing"),
);

const FAILED_ITEM_HEIGHT = 140;
const {
  list: virtualList,
  containerProps,
  wrapperProps,
} = useVirtualList(filteredFailed, {
  itemHeight: FAILED_ITEM_HEIGHT,
  overscan: 4,
});

const openTaskDetail = async (taskId: string) => {
  visible.value = false;
  await router.push({ name: "TaskDetail", params: { id: taskId } });
};

const openFailedUrl = async (url: string) => {
  try {
    await openExternalLink(url);
  } catch {
    kameMessage.error(t("common.openUrlFailed"));
  }
};

const getFailedPluginName = (pluginId: string) => {
  return pluginStore.pluginLabel(pluginId);
};

const formatFailedTime = (value: number) => {
  if (!value) return "";
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toLocaleString();
};

const copyFailedError = async (failed: TaskFailedImage) => {
  const pluginName = getFailedPluginName(failed.pluginId);
  const timeStr = formatFailedTime(failed.createdAt);
  const text = [
    `[${t("tasks.filterFailed")}]`,
    `${t("tasks.failedUrl")}: ${failed.url}`,
    `${t("tasks.failedError")}: ${failed.lastError || "-"}`,
    `${t("tasks.failedPlugin")}: ${pluginName}`,
    `${t("tasks.failedTime")}: ${timeStr}`,
  ].join("\n");
  try {
    if (isTauri()) {
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    kameMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
};

const handleRetryFailedImage = async (failed: TaskFailedImage) => {
  if (getItemState(failed).isActive) return;
  try {
    await failedImagesStore.retryFailed(failed.id);
    kameMessage.success(t("tasks.retryDownloadSent"));
  } catch (error) {
    console.error("重试下载失败:", error);
    kameMessage.error(t("tasks.retryDownloadFailed"));
  }
};

const handleCancelRetry = async (failedId: number) => {
  try {
    await failedImagesStore.cancelRetry(failedId);
  } catch (e) {
    console.error(e);
    kameMessage.error(t("tasks.cancelRetryFailed"));
  }
};

const handleRetryAll = async () => {
  const idleItems = filteredFailed.value.filter((f) => !getItemState(f).isActive);
  if (!idleItems.length) return;
  bulkRetryLoading.value = true;
  try {
    await failedImagesStore.retryMany(idleItems.map((f) => f.id));
    kameMessage.success(t("tasks.retryAllSent"));
  } catch (error) {
    console.error(error);
    kameMessage.error(t("tasks.retryDownloadFailed"));
  } finally {
    bulkRetryLoading.value = false;
  }
};

const handleCancelAll = async () => {
  const preparingItems = filteredFailed.value.filter(
    (f) => downloadStore.getByFailedImageId(f.id)?.state === "preparing",
  );
  if (!preparingItems.length) return;
  try {
    await failedImagesStore.cancelRetryMany(preparingItems.map((f) => f.id));
  } catch (e) {
    console.error(e);
    kameMessage.error(t("tasks.cancelRetryFailed"));
  }
};

const handleDeleteAll = async () => {
  const idleItems = filteredFailed.value.filter((f) => !getItemState(f).isActive);
  if (!idleItems.length) return;
  try {
    await messageBox.confirm(t("tasks.deleteAllConfirmMessage", { n: idleItems.length }), t("tasks.deleteAllConfirm"), {
      type: "warning",
    });
  } catch {
    return;
  }
  bulkDeleteLoading.value = true;
  try {
    await failedImagesStore.deleteMany(idleItems.map((f) => f.id));
    kameMessage.success(t("tasks.deleteAllSuccess"));
  } catch (e) {
    console.error(e);
    kameMessage.error(t("tasks.deleteFailedRecordFailed"));
  } finally {
    bulkDeleteLoading.value = false;
  }
};

const handleDeleteFailedImage = async (failedId: number) => {
  try {
    await failedImagesStore.deleteFailed(failedId);
    kameMessage.success(t("tasks.deleteFailedRecordSuccess"));
  } catch (error) {
    console.error("删除失败记录失败:", error);
    kameMessage.error(t("tasks.deleteFailedRecordFailed"));
  }
};
</script>
