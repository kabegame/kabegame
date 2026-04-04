<template>
  <div class="organize-header-control">
    <el-popover
      v-model:visible="showProgressPopover"
      trigger="manual"
      placement="bottom-end"
      :width="340"
    >
      <template #reference>
        <el-tooltip :content="progressTooltipText" :disabled="!loading" placement="bottom">
          <el-button circle :title="loading ? progressTooltipText : t('header.organize')" @click="handleOrganizeButtonClick">
            <el-icon :class="{ 'organizing-icon': loading }">
              <FolderOpened />
            </el-icon>
          </el-button>
        </el-tooltip>
      </template>

      <div class="organize-progress-popover">
        <div class="popover-title">{{ t("gallery.organizeRunProgress") }}</div>
        <div class="popover-progress-text">{{ progressSummaryText }}</div>
        <el-progress :percentage="progressPercentage" :stroke-width="8" />
        <div v-if="progress.removed > 0 || progress.regenerated > 0" class="popover-progress-detail">
          {{ t("gallery.organizingDetail", { removed: progress.removed, regenerated: progress.regenerated }) }}
        </div>
        <div class="popover-note">{{ t("gallery.organizeNoNewDownloadHint") }}</div>

        <div class="popover-subtitle">{{ t("gallery.organizeRunOptions") }}</div>
        <div class="popover-options">
          <template v-if="optionRows.length > 0">
            <div v-for="item in optionRows" :key="item.key" class="option-row">
              <span class="option-label">{{ item.label }}</span>
              <el-tag size="small" effect="plain" :type="item.enabled ? 'success' : 'info'">
                {{ item.enabled ? t("gallery.organizeOptionEnabled") : t("gallery.organizeOptionDisabled") }}
              </el-tag>
            </div>
          </template>
          <div v-else class="option-empty">{{ t("common.noData") }}</div>
          <div class="option-row">
            <span class="option-label">{{ t("gallery.organizeRange") }}</span>
            <span class="option-value">{{ rangeText }}</span>
          </div>
        </div>

        <div class="popover-actions">
          <el-button type="danger" link @click="handleCancel">{{ t("common.cancel") }}</el-button>
          <el-button size="small" type="primary" @click="showProgressPopover = false">{{ t("common.confirm") }}</el-button>
        </div>
      </div>
    </el-popover>

    <Teleport to="body">
      <OrganizeDialog v-model="showDialog" :loading="loading" @confirm="handleConfirm" />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpened } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import OrganizeDialog from "@/components/OrganizeDialog.vue";

type OrganizeOptions = {
  dedupe: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  deleteSourceFiles: boolean;
  safeDelete: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
};

const { t } = useI18n();
const loading = ref(false);
const showDialog = ref(false);
const showProgressPopover = ref(false);
const progress = ref({ processed: 0, total: 0, removed: 0, regenerated: 0 });
const lastRunOptions = ref<OrganizeOptions | null>(null);

let unlistenProgress: (() => void) | undefined;
let unlistenFinished: (() => void) | undefined;
useModalBack(showProgressPopover);

const progressSummaryText = computed(() =>
  progress.value.total > 0
    ? t("gallery.organizingProgress", { processed: progress.value.processed, total: progress.value.total })
    : t("gallery.organizingEllipsis")
);

const progressTooltipText = computed(() => {
  if (!loading.value) return "";
  const detail =
    progress.value.removed > 0 || progress.value.regenerated > 0
      ? ` ${t("gallery.organizingDetail", { removed: progress.value.removed, regenerated: progress.value.regenerated })}`
      : "";
  return `${progressSummaryText.value}${detail}`;
});

const progressPercentage = computed(() => {
  if (progress.value.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress.value.processed / progress.value.total) * 100)));
});

const optionRows = computed(() => {
  const options = lastRunOptions.value;
  if (!options) return [];
  return [
    { key: "dedupe", label: t("gallery.dedupe"), enabled: options.dedupe },
    { key: "removeMissing", label: t("gallery.removeMissing"), enabled: options.removeMissing },
    { key: "removeUnrecognized", label: t("gallery.removeUnrecognized"), enabled: options.removeUnrecognized },
    { key: "regenThumbnails", label: t("gallery.regenThumbnails"), enabled: options.regenThumbnails },
    { key: "deleteSourceFiles", label: t("gallery.deleteSourceFiles"), enabled: options.deleteSourceFiles },
    {
      key: "safeDelete",
      label: t("gallery.safeDelete"),
      enabled: options.deleteSourceFiles ? options.safeDelete : false,
    },
  ];
});

const rangeText = computed(() => {
  const options = lastRunOptions.value;
  if (!options || (options.rangeStart == null && options.rangeEnd == null)) {
    return t("gallery.organizeRangeAll");
  }
  const start = options.rangeStart ?? 0;
  const end = options.rangeEnd ?? 0;
  return t("gallery.organizeRangeSegment", { start, end });
});

onMounted(async () => {
  unlistenProgress = await listen<{
    processed: number;
    total: number;
    removed: number;
    regenerated: number;
  }>("organize-progress", (event) => {
    const p = event.payload;
    if (!p) return;
    progress.value = {
      processed: p.processed,
      total: p.total,
      removed: p.removed,
      regenerated: p.regenerated,
    };
  });

  unlistenFinished = await listen<{
    removed: number;
    regenerated: number;
    canceled: boolean;
  }>("organize-finished", (event) => {
    const p = event.payload;
    loading.value = false;
    showProgressPopover.value = false;
    if (p?.canceled) {
      ElMessage.info(t("gallery.organizeCanceled"));
      return;
    }
    ElMessage.success(t("gallery.organizeDone", { removed: p?.removed ?? 0, regenerated: p?.regenerated ?? 0 }));
  });
});

onUnmounted(() => {
  unlistenProgress?.();
  unlistenFinished?.();
});

async function handleConfirm(options: {
  dedupe: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  deleteSourceFiles: boolean;
  safeDelete: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
}) {
  showDialog.value = false;
  if (loading.value) return;
  try {
    loading.value = true;
    showProgressPopover.value = false;
    progress.value = { processed: 0, total: 0, removed: 0, regenerated: 0 };
    lastRunOptions.value = { ...options };
    await invoke("start_organize", {
      args: {
        dedupe: options.dedupe,
        removeMissing: options.removeMissing,
        removeUnrecognized: options.removeUnrecognized,
        regenThumbnails: options.regenThumbnails,
        deleteSourceFiles: options.deleteSourceFiles,
        safeDelete: options.safeDelete,
        rangeStart: options.rangeStart,
        rangeEnd: options.rangeEnd,
      },
    });
  } catch (e) {
    console.error("启动整理失败:", e);
    ElMessage.error(t("gallery.startOrganizeFailed"));
    loading.value = false;
  }
}

function handleOrganizeButtonClick() {
  if (loading.value) {
    showProgressPopover.value = !showProgressPopover.value;
    return;
  }
  showDialog.value = true;
}

async function handleCancel() {
  if (!loading.value) return;
  try {
    const ok = await invoke<boolean>("cancel_organize");
    if (ok) ElMessage.info(t("gallery.cancelOrganizeRequested"));
  } catch (e) {
    console.error("取消整理失败:", e);
    ElMessage.error(t("gallery.cancelOrganizeFailed"));
  }
}
</script>

<style scoped lang="scss">
.organize-header-control {
  display: inline-flex;
  align-items: center;
}

.organizing-icon {
  animation: organize-rotating 1s linear infinite;
}

.organize-progress-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;

  .popover-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .popover-progress-text {
    color: var(--el-text-color-primary);
  }

  .popover-progress-detail,
  .popover-note {
    color: var(--el-text-color-secondary);
    line-height: 1.4;
  }

  .popover-subtitle {
    margin-top: 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--el-text-color-primary);
  }

  .popover-options {
    border-radius: 8px;
    border: 1px solid var(--el-border-color-lighter);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .option-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .option-label {
    color: var(--el-text-color-primary);
  }

  .option-value {
    color: var(--el-text-color-secondary);
  }

  .option-empty {
    color: var(--el-text-color-secondary);
  }

  .popover-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
}

.el-button {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

@keyframes organize-rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
