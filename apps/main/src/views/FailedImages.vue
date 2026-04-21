<template>
  <div class="failed-images-page" v-pull-to-refresh="pullToRefreshOpts">
    <div v-bind="containerProps" class="failed-list-container">
      <FailedImagesToolbar
        :subtitle-text="subtitleText"
        :has-pending-in-filter="hasPendingInFilter"
        :has-idle-in-filter="hasIdleInFilter"
        :plugin-filter-label="pluginFilterLabel"
        :plugin-groups="pluginGroups"
        :filter-plugin-id="filterPluginId"
        :all-failed-length="allFailed.length"
        :bulk-retry-loading="bulkRetryLoading"
        :bulk-delete-loading="bulkDeleteLoading"
        :plugin-store="pluginStore"
        @cancel-all="handleCancelAll"
        @retry-all="handleRetryAll"
        @delete-all="handleDeleteAll"
        @filter-command="onPluginFilterCommand"
        @quick-settings="openQuickSettings"
      />

      <el-skeleton v-if="loading" :rows="8" animated />
      <el-empty
        v-else-if="allFailed.length === 0"
        :description="t('tasks.allFailedImagesEmpty')"
      />
      <el-empty
        v-else-if="filteredFailed.length === 0"
        :description="t('tasks.failedFilterEmpty')"
      />
      <div v-else v-bind="wrapperProps" class="failed-list-wrapper">
        <div v-for="{ data: failed } in virtualList" :key="failed.id" class="failed-list-item">
          <div class="failed-item">
            <div class="failed-item-head">
              <div class="left">
                <el-tag size="small" type="warning">{{ getFailedPluginName(failed.pluginId) }}</el-tag>
                <span class="time">{{ formatFailedTime(failed.createdAt) }}</span>
                <el-tag v-if="itemStateTag(failed)" size="small" type="info" class="state-tag">
                  {{ itemStateTag(failed) }}
                </el-tag>
              </div>
              <el-button
                link
                size="small"
                type="primary"
                @click="openTaskDetail(failed.taskId)"
              >
                {{ t("tasks.viewTask") }}
              </el-button>
            </div>

            <div class="failed-item-body">
              <div class="row">
                <span class="label">{{ t("tasks.failedUrl") }}</span>
                <a
                  class="value link-blue-italic"
                  :href="failed.url"
                  target="_blank"
                  rel="noopener"
                  @click.prevent="openFailedUrl(failed.url)"
                >
                  {{ failed.url }}
                </a>
              </div>
              <div class="failed-preview-row">
                <el-image
                  :src="failed.url"
                  fit="contain"
                  class="failed-preview-img"
                  :preview-src-list="[failed.url]"
                >
                  <template #placeholder>
                    <div class="failed-image-slot failed-image-loading">
                      <el-icon class="is-loading"><Loading /></el-icon>
                      <span>{{ t("common.loading") }}</span>
                    </div>
                  </template>
                  <template #error>
                    <div class="failed-image-slot failed-image-error">
                      <el-icon><Picture /></el-icon>
                      <span>{{ t("tasks.failedImageLoadError") }}</span>
                    </div>
                  </template>
                </el-image>
              </div>
              <div class="failed-error-box">
                <div class="error-message">
                  <el-icon class="error-icon">
                    <WarningFilled />
                  </el-icon>
                  <span class="error-text">{{ failed.lastError || "-" }}</span>
                  <el-button text size="small" class="copy-error-btn" :title="t('tasks.copyErrorDetails')" @click="copyFailedError(failed)">
                    <el-icon>
                      <CopyDocument />
                    </el-icon>
                  </el-button>
                </div>
              </div>
            </div>

            <div class="failed-item-actions">
              <template v-if="getItemState(failed).isActive">
                <el-button
                  v-if="getItemState(failed).state === 'waiting'"
                  size="small"
                  @click="handleCancelRetry(failed.id)"
                >
                  {{ t("tasks.cancelRetry") }}
                </el-button>
              </template>
              <template v-else>
                <el-button
                  type="primary"
                  size="small"
                  :loading="pendingRetryIds.has(failed.id)"
                  @click="handleRetryFailedImage(failed)"
                >
                  {{ t("tasks.retryDownload") }}
                </el-button>
                <el-button type="danger" plain size="small" @click="handleDeleteFailedImage(failed.id)">
                  {{ t("tasks.deleteFailedRecord") }}
                </el-button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useVirtualList } from "@vueuse/core";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { CopyDocument, Loading, Picture, WarningFilled } from "@element-plus/icons-vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen, type UnlistenFn } from "@/api/rpc";
import { useI18n, usePluginManifestI18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { useFailedImagesStore } from "@/stores/failedImages";
import type { TaskFailedImage } from "@kabegame/core/types/image";
import FailedImagesToolbar from "@/components/FailedImagesToolbar.vue";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { IS_ANDROID } from "@kabegame/core/env";

const { t } = useI18n();
const { pluginName: resolvePluginName } = usePluginManifestI18n();
const router = useRouter();
const pluginStore = usePluginStore();
const failedImagesStore = useFailedImagesStore();
const quickSettingsDrawer = useQuickSettingsDrawerStore();
const openQuickSettings = () => quickSettingsDrawer.open("failedimages");

const filterPluginId = ref<string | null>(null);
const pendingRetryIds = ref(new Set<number>());
const downloadStateMap = reactive<Record<string, { state: string; progress?: number }>>({});
const bulkRetryLoading = ref(false);
const bulkDeleteLoading = ref(false);

let unlistenDownloadState: UnlistenFn | null = null;
let unlistenDownloadProgress: UnlistenFn | null = null;

const allFailed = computed(() => failedImagesStore.allFailed);
const loading = computed(() => failedImagesStore.loading);

const pullToRefreshOpts = computed(() =>
  IS_ANDROID
    ? { onRefresh: () => failedImagesStore.loadAll(), refreshing: loading.value }
    : undefined
);

/** 有失效图片的插件分组（仅含 count > 0） */
const pluginGroups = computed(() => {
  const list = allFailed.value;
  const map = new Map<string, number>();
  for (const item of list) {
    const id = item.pluginId || "";
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .filter(([, count]) => count > 0)
    .map(([pluginId, count]) => ({ pluginId, count }))
    .sort((a, b) => b.count - a.count);
});

/** 按插件筛选后的列表（前端筛选） */
const filteredFailed = computed(() => {
  const list = allFailed.value;
  const pid = filterPluginId.value;
  if (!pid) return list;
  return list.filter((item) => item.pluginId === pid);
});

const subtitleText = computed(() =>
  t("tasks.failedCount", { n: filteredFailed.value.length })
);

const pluginFilterLabel = computed(() => {
  const pid = filterPluginId.value;
  if (!pid) return t("gallery.filterAll");
  return t("gallery.filterByPluginWithName", {
    name: pluginStore.pluginLabel(pid),
  });
});

const getItemState = (item: TaskFailedImage) => {
  const ds = downloadStateMap[item.url];
  if (ds && ["preparing", "downloading", "processing"].includes(ds.state)) {
    return { isActive: true, state: ds.state, progress: ds.progress } as const;
  }
  if (pendingRetryIds.value.has(item.id)) {
    return { isActive: true, state: "waiting" as const };
  }
  return { isActive: false } as const;
};

const itemStateTag = (item: TaskFailedImage) => {
  const s = getItemState(item);
  if (!s.isActive) return "";
  if (s.state === "waiting") return t("tasks.stateWaiting");
  if (s.state === "preparing") return t("tasks.statePreparing");
  if (s.state === "downloading") return t("tasks.stateDownloading");
  if (s.state === "processing") return t("tasks.stateProcessing");
  return "";
};

const hasIdleInFilter = computed(() =>
  filteredFailed.value.some((f) => !getItemState(f).isActive)
);

const hasPendingInFilter = computed(() =>
  filteredFailed.value.some((f) => pendingRetryIds.value.has(f.id))
);

function onPluginFilterCommand(cmd: string) {
  filterPluginId.value = cmd === "" ? null : cmd || null;
}

const FAILED_ITEM_HEIGHT = 384;
const { list: virtualList, containerProps, wrapperProps } = useVirtualList(filteredFailed, {
  itemHeight: FAILED_ITEM_HEIGHT,
  overscan: 3,
});

const openTaskDetail = async (taskId: string) => {
  await router.push({ name: "TaskDetail", params: { id: taskId } });
};

const openFailedUrl = async (url: string) => {
  try {
    await openUrl(url);
  } catch {
    ElMessage.error(t("common.openUrlFailed"));
  }
};

const getFailedPluginName = (pluginId: string) => {
  if (pluginId === "local-import") return t("tasks.drawerLocalImport");
  const plugin = pluginStore.plugins.find((p) => p.id === pluginId);
  return plugin ? (resolvePluginName(plugin) || pluginId) : pluginId;
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
    const { isTauri } = await import("@tauri-apps/api/core");
    if (isTauri()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
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
  if (pendingRetryIds.value.has(failed.id)) return;
  pendingRetryIds.value.add(failed.id);
  try {
    await failedImagesStore.retryFailed(failed.id);
    ElMessage.success(t("tasks.retryDownloadSent"));
  } catch (error) {
    console.error("重试下载失败:", error);
    pendingRetryIds.value.delete(failed.id);
    ElMessage.error(t("tasks.retryDownloadFailed"));
  }
};

const handleCancelRetry = async (failedId: number) => {
  try {
    await failedImagesStore.cancelRetry(failedId);
    pendingRetryIds.value.delete(failedId);
  } catch (e) {
    console.error(e);
    ElMessage.error(t("tasks.cancelRetryFailed"));
  }
};

const handleRetryAll = async () => {
  const idleItems = filteredFailed.value.filter((f) => !getItemState(f).isActive);
  if (!idleItems.length) return;
  const ids = idleItems.map((f) => f.id);
  idleItems.forEach((f) => pendingRetryIds.value.add(f.id));
  bulkRetryLoading.value = true;
  try {
    const submitted = await failedImagesStore.retryMany(ids);
    const submittedSet = new Set(submitted);
    idleItems.forEach((f) => {
      if (!submittedSet.has(f.id)) pendingRetryIds.value.delete(f.id);
    });
    ElMessage.success(t("tasks.retryAllSent"));
  } catch (error) {
    console.error(error);
    idleItems.forEach((f) => pendingRetryIds.value.delete(f.id));
    ElMessage.error(t("tasks.retryDownloadFailed"));
  } finally {
    bulkRetryLoading.value = false;
  }
};

const handleCancelAll = async () => {
  const pendingItems = filteredFailed.value.filter((f) => pendingRetryIds.value.has(f.id));
  if (!pendingItems.length) return;
  const ids = pendingItems.map((f) => f.id);
  try {
    await failedImagesStore.cancelRetryMany(ids);
    ids.forEach((id) => pendingRetryIds.value.delete(id));
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

watch(
  () => failedImagesStore.allFailed,
  (list) => {
    const ids = new Set(list.map((f) => f.id));
    for (const id of Array.from(pendingRetryIds.value)) {
      if (!ids.has(id)) pendingRetryIds.value.delete(id);
    }
    const urlSet = new Set(list.map((f) => f.url));
    for (const url of Object.keys(downloadStateMap)) {
      if (!urlSet.has(url)) delete downloadStateMap[url];
    }
  },
  { deep: true }
);

onMounted(async () => {
  await failedImagesStore.initListeners();
  await failedImagesStore.loadAll();

  unlistenDownloadState = await listen("download-state", (event) => {
    const payload = event.payload as Record<string, unknown>;
    const url = String(payload?.url ?? "").trim();
    const state = String(payload?.state ?? "").trim();
    if (!url || !state) return;
    if (["preparing", "downloading", "processing"].includes(state)) {
      downloadStateMap[url] = {
        ...downloadStateMap[url],
        state,
      };
      for (const row of allFailed.value) {
        if (row.url === url) pendingRetryIds.value.delete(row.id);
      }
    } else {
      delete downloadStateMap[url];
    }
  });

  unlistenDownloadProgress = await listen("download-progress", (event) => {
    const payload = event.payload as Record<string, unknown>;
    const url = String(payload?.url ?? "").trim();
    const received = Number(payload?.received_bytes ?? payload?.receivedBytes ?? 0);
    const total = payload?.total_bytes ?? payload?.totalBytes;
    const totalN = total != null ? Number(total) : NaN;
    if (!url) return;
    const progress =
      Number.isFinite(totalN) && totalN > 0
        ? Math.min(100, Math.round((received / totalN) * 100))
        : undefined;
    if (downloadStateMap[url]) {
      downloadStateMap[url].progress = progress;
    }
  });
});

onUnmounted(() => {
  unlistenDownloadState?.();
  unlistenDownloadState = null;
  unlistenDownloadProgress?.();
  unlistenDownloadProgress = null;
});
</script>

<style scoped lang="scss">
.failed-images-page {
  padding: 20px;
  height: 100%;
  min-height: 0;
}

.failed-list-container {
  height: calc(100vh - 40px);
  overflow-y: auto;
}

.failed-list-wrapper {
  min-height: 0;
}

.failed-list-item {
  height: 372px;
  padding-bottom: 12px;
  box-sizing: border-box;
}

.failed-item {
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  padding: 12px;
  background: var(--el-bg-color-overlay);
}

.failed-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .time {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .state-tag {
    font-size: 11px;
  }
}

.failed-item-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.failed-preview-row {
  margin-top: 4px;
}

.failed-preview-img {
  display: block;
  width: 100%;
  max-width: 280px;
  height: 160px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
}

.failed-image-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  min-height: 120px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.failed-image-loading .el-icon {
  font-size: 24px;
}

.failed-image-error .el-icon {
  font-size: 28px;
}

.row {
  display: flex;
  gap: 8px;
  min-width: 0;

  .label {
    flex: 0 0 auto;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--el-text-color-primary);
    font-size: 12px;
  }

  .link-blue-italic {
    color: var(--el-color-primary);
    font-style: italic;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

/* 错误信息红框：固定高度约三行，超出可滚动 */
.failed-error-box {
  margin-top: 6px;
  height: 84px;
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  box-sizing: border-box;

  .error-message {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    height: 100%;
    min-height: 0;
    color: var(--el-text-color-primary);
    overflow-y: auto;
  }

  .error-icon {
    color: #ef4444;
    font-size: 18px;
    flex-shrink: 0;
  }

  .error-text {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
    overflow-y: auto;
  }

  .copy-error-btn {
    flex-shrink: 0;
    color: var(--el-text-color-secondary);
    transition: color 0.2s ease;

    &:hover {
      color: var(--el-color-primary);
    }
  }
}

.failed-item-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

</style>
