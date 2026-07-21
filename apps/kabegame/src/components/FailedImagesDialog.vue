<template>
  <el-dialog
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    :width="dialogWidth"
    :style="dialogStyle"
    :append-to-body="true"
    :close-on-click-modal="true"
    class="failed-images-dialog"
    @update:model-value="modal.close"
  >
    <template #header>
      <div class="fid-header">
        <div class="fid-header-left">
          <span class="fid-title">{{ dialogTitle }}</span>
          <el-tag size="small" type="info" class="fid-count-tag">{{ filteredFailed.length }}</el-tag>
        </div>
        <div class="fid-header-right">
          <el-dropdown v-if="pluginGroups.length > 1" trigger="click" @command="onPluginFilterCommand">
            <el-button size="small" plain>
              {{ pluginFilterLabel }}<el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="">{{ t('gallery.filterAll') }}</el-dropdown-item>
                <el-dropdown-item
                  v-for="g in pluginGroups"
                  :key="g.pluginId"
                  :command="g.pluginId"
                >{{ getFailedPluginName(g.pluginId) }} ({{ g.count }})</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button
            v-if="hasPendingInFilter"
            size="small"
            :icon="CircleClose"
            @click="handleCancelAll"
          >{{ t('header.failedImagesCancelWaiting') }}</el-button>
          <el-button
            v-if="hasIdleInFilter"
            size="small"
            type="primary"
            :icon="Refresh"
            :loading="bulkRetryLoading"
            @click="handleRetryAll"
          >{{ t('header.failedImagesRetryAll') }}</el-button>
          <el-button
            v-if="hasIdleInFilter"
            size="small"
            type="danger"
            plain
            :icon="Delete"
            :loading="bulkDeleteLoading"
            @click="handleDeleteAll"
          >{{ t('header.failedImagesDeleteAll') }}</el-button>
        </div>
      </div>
    </template>

    <el-skeleton v-if="loading" :rows="5" animated />
    <el-empty
      v-else-if="baseList.length === 0"
      :description="t('tasks.allFailedImagesEmpty')"
    />
    <el-empty
      v-else-if="filteredFailed.length === 0"
      :description="t('tasks.failedFilterEmpty')"
    />
    <div v-else v-bind="containerProps" class="fid-list">
      <div v-bind="wrapperProps">
        <div
          v-for="{ data: failed } in virtualList"
          :key="failed.id"
          class="fid-item-wrap"
        >
          <div class="fid-item">
            <el-image
              :src="failed.url"
              fit="contain"
              class="fid-thumb"
              :preview-src-list="[failed.url]"
            >
              <template #placeholder>
                <div class="fid-thumb-slot">
                  <el-icon class="is-loading"><Loading /></el-icon>
                </div>
              </template>
              <template #error>
                <div class="fid-thumb-slot fid-thumb-err">
                  <el-icon><Picture /></el-icon>
                </div>
              </template>
            </el-image>

            <div class="fid-info">
              <div class="fid-info-head">
                <div class="fid-tags">
                  <el-tag size="small" type="warning">{{ getFailedPluginName(failed.pluginId) }}</el-tag>
                  <el-tag v-if="itemStateTag(failed)" size="small" :type="itemStateTagType(failed)">{{ itemStateTag(failed) }}</el-tag>
                  <span class="fid-time">{{ formatFailedTime(failed.createdAt) }}</span>
                </div>
                <el-button link size="small" type="primary" @click="openTaskDetail(failed.taskId)">
                  {{ t('tasks.viewTask') }}
                </el-button>
              </div>

              <a
                class="fid-url"
                :href="failed.url"
                target="_blank"
                rel="noopener"
                @click.prevent="openFailedUrl(failed.url)"
              >{{ failed.url }}</a>

              <div class="fid-error-row">
                <el-icon class="fid-error-icon"><WarningFilled /></el-icon>
                <span class="fid-error-text">{{ failed.lastError || '-' }}</span>
                <el-button text size="small" class="fid-copy-btn" :title="t('tasks.copyErrorDetails')" @click="copyFailedError(failed)">
                  <el-icon><CopyDocument /></el-icon>
                </el-button>
              </div>

              <div class="fid-actions">
                <template v-if="getItemState(failed).isActive && getItemState(failed).state === 'preparing'">
                  <el-button size="small" @click="handleCancelRetry(failed.id)">
                    {{ t('tasks.cancelRetry') }}
                  </el-button>
                </template>
                <template v-else-if="!getItemState(failed).isActive">
                  <el-button
                    type="primary"
                    size="small"
                    :loading="getItemState(failed).isActive"
                    @click="handleRetryFailedImage(failed)"
                  >{{ t('tasks.retryDownload') }}</el-button>
                  <el-button
                    type="danger"
                    plain
                    size="small"
                    @click="handleDeleteFailedImage(failed.id)"
                  >{{ t('tasks.deleteFailedRecord') }}</el-button>
                </template>
              </div>
            </div>

            <!-- Download progress bar overlay -->
            <div
              v-if="getItemState(failed).isActive && getItemState(failed).state !== 'waiting'"
              class="fid-progress-bar"
              :class="getItemState(failed).progress != null ? 'fid-progress-bar--det' : 'fid-progress-bar--indet'"
              :style="getItemState(failed).progress != null ? { width: getItemState(failed).progress + '%' } : undefined"
            />
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import { useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import {
  ArrowDown,
  CircleClose,
  CopyDocument,
  Delete,
  Loading,
  Picture,
  Refresh,
  WarningFilled,
} from "@element-plus/icons-vue";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { useFailedImagesStore } from "@/stores/failedImages";
import { useDownloadStateStore } from "@/stores/downloadState";
import type { TaskFailedImage } from "@kabegame/core/types/image";
import { useModal } from "@kabegame/core/composables/useModal";
import { useUiStore } from "@kabegame/core/stores/ui";
import { openExternalLink } from "@kabegame/core/utils/openExternalLink";

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
const dialogWidth = computed(() => (isCompact.value ? "95vw" : "min(760px, 92vw)"));
const dialogStyle = computed(() => (isCompact.value ? { marginTop: "2vh" } : undefined));

const modal = useModal({ onClose: () => emit("update:modelValue", false) });
watch(
  () => props.modelValue,
  (v) => (v ? modal.open() : modal.close()),
  { immediate: true }
);

const activeTaskId = ref<string | undefined>(undefined);
const effectiveTaskId = computed(() => activeTaskId.value ?? props.taskId);

const setTaskId = (taskId?: string) => {
  activeTaskId.value = taskId;
  filterPluginId.value = null;
};

// Imperative API used by refs; scope is set separately via setTaskId().
const open = () => {
  modal.open();
};

defineExpose({ open, setTaskId });

const filterPluginId = ref<string | null>(null);
const bulkRetryLoading = ref(false);
const bulkDeleteLoading = ref(false);

const allFailed = computed(() => failedImagesStore.allFailed);
const loading = computed(() => failedImagesStore.loading);

/** Source list: scoped to taskId (if provided), otherwise all failures */
const baseList = computed(() =>
  effectiveTaskId.value
    ? allFailed.value.filter((f) => f.taskId === effectiveTaskId.value)
    : allFailed.value
);

const dialogTitle = computed(() =>
  effectiveTaskId.value ? t("tasks.failedImagesForTask") : t("header.failedImages")
);

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

const itemStateTagType = (item: TaskFailedImage): "info" | "warning" | "success" | "danger" => {
  const s = getItemState(item);
  if (!s.isActive) return "info";
  if (s.state === "failed") return "danger";
  if (s.state === "completed" || s.state === "processing") return "success";
  if (s.state === "downloading" || s.state === "preparing") return "warning";
  return "info";
};

const hasIdleInFilter = computed(() => filteredFailed.value.some((f) => !getItemState(f).isActive));
const hasPendingInFilter = computed(() =>
  filteredFailed.value.some((f) => downloadStore.getByFailedImageId(f.id)?.state === "preparing")
);

function onPluginFilterCommand(cmd: string) {
  filterPluginId.value = cmd === "" ? null : cmd || null;
}

const FAILED_ITEM_HEIGHT = 140;
const { list: virtualList, containerProps, wrapperProps } = useVirtualList(filteredFailed, {
  itemHeight: FAILED_ITEM_HEIGHT,
  overscan: 4,
});

const openTaskDetail = async (taskId: string) => {
  modal.close();
  await router.push({ name: "TaskDetail", params: { id: taskId } });
};

const openFailedUrl = async (url: string) => {
  try {
    await openExternalLink(url);
  } catch {
    ElMessage.error(t("common.openUrlFailed"));
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
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
};

const handleRetryFailedImage = async (failed: TaskFailedImage) => {
  if (getItemState(failed).isActive) return;
  try {
    await failedImagesStore.retryFailed(failed.id);
    ElMessage.success(t("tasks.retryDownloadSent"));
  } catch (error) {
    console.error("重试下载失败:", error);
    ElMessage.error(t("tasks.retryDownloadFailed"));
  }
};

const handleCancelRetry = async (failedId: number) => {
  try {
    await failedImagesStore.cancelRetry(failedId);
  } catch (e) {
    console.error(e);
    ElMessage.error(t("tasks.cancelRetryFailed"));
  }
};

const handleRetryAll = async () => {
  const idleItems = filteredFailed.value.filter((f) => !getItemState(f).isActive);
  if (!idleItems.length) return;
  bulkRetryLoading.value = true;
  try {
    await failedImagesStore.retryMany(idleItems.map((f) => f.id));
    ElMessage.success(t("tasks.retryAllSent"));
  } catch (error) {
    console.error(error);
    ElMessage.error(t("tasks.retryDownloadFailed"));
  } finally {
    bulkRetryLoading.value = false;
  }
};

const handleCancelAll = async () => {
  const preparingItems = filteredFailed.value.filter(
    (f) => downloadStore.getByFailedImageId(f.id)?.state === "preparing"
  );
  if (!preparingItems.length) return;
  try {
    await failedImagesStore.cancelRetryMany(preparingItems.map((f) => f.id));
  } catch (e) {
    console.error(e);
    ElMessage.error(t("tasks.cancelRetryFailed"));
  }
};

const handleDeleteAll = async () => {
  const idleItems = filteredFailed.value.filter((f) => !getItemState(f).isActive);
  if (!idleItems.length) return;
  try {
    await ElMessageBox.confirm(
      t("tasks.deleteAllConfirmMessage", { n: idleItems.length }),
      t("tasks.deleteAllConfirm"),
      { type: "warning" }
    );
  } catch {
    return;
  }
  bulkDeleteLoading.value = true;
  try {
    await failedImagesStore.deleteMany(idleItems.map((f) => f.id));
    ElMessage.success(t("tasks.deleteAllSuccess"));
  } catch (e) {
    console.error(e);
    ElMessage.error(t("tasks.deleteFailedRecordFailed"));
  } finally {
    bulkDeleteLoading.value = false;
  }
};

const handleDeleteFailedImage = async (failedId: number) => {
  try {
    await failedImagesStore.deleteFailed(failedId);
    ElMessage.success(t("tasks.deleteFailedRecordSuccess"));
  } catch (error) {
    console.error("删除失败记录失败:", error);
    ElMessage.error(t("tasks.deleteFailedRecordFailed"));
  }
};
</script>

<style scoped lang="scss">
.fid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.fid-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.fid-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fid-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}

.fid-count-tag {
  font-size: 11px;
}

.fid-list {
  /* 小屏（Android/矮窗口）随视口收缩，避免对话框超出屏幕 */
  height: min(480px, 60vh);
  overflow-y: auto;
}

.fid-item-wrap {
  height: 140px;
  padding-bottom: 10px;
  box-sizing: border-box;
}

.fid-item {
  position: relative;
  display: flex;
  gap: 10px;
  height: 100%;
  padding: 10px 12px;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
  overflow: hidden;
}

/* thumbnail */
.fid-thumb {
  flex-shrink: 0;
  width: 80px;
  height: 100%;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}

.fid-thumb-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 20px;
}

.fid-thumb-err {
  font-size: 22px;
}

/* info column */
.fid-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: space-between;
}

.fid-info-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.fid-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

.fid-time {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.fid-url {
  display: block;
  font-size: 11px;
  color: var(--el-color-primary);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.fid-error-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.fid-error-icon {
  flex-shrink: 0;
  color: #ef4444;
  font-size: 14px;
  margin-top: 1px;
}

.fid-error-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.fid-copy-btn {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--el-color-primary);
  }
}

.fid-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* progress bar — absolute overlay at card bottom */
.fid-progress-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  border-radius: 0 0 10px 10px;
  background-color: var(--el-color-primary);
  pointer-events: none;
}

.fid-progress-bar--det {
  transition: width 0.3s ease;
}

.fid-progress-bar--indet {
  width: 40%;
  animation: fid-shimmer 1.4s infinite ease-in-out;
}

@keyframes fid-shimmer {
  0% { left: -40%; }
  100% { left: 100%; }
}
</style>
