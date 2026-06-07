<template>
  <div class="organize-header-control">
    <el-popover
      :visible="progressPopover.isOpen.value"
      trigger="manual"
      placement="bottom-end"
      :width="340"
      @update:visible="progressPopover.close"
    >
      <template #reference>
        <!-- 单层组件根非原生节点时，ElPopover 的运行时指令无法正确挂载，需包一层元素 -->
        <span class="organize-popover-ref">
          <el-tooltip :content="progressTooltipText" :disabled="!loading" placement="bottom">
            <span class="organize-tooltip-trigger">
              <el-button circle :title="loading ? progressTooltipText : t('header.organize')" @click="handleOrganizeButtonClick">
                <el-icon :class="{ 'organizing-icon': loading }">
                  <FolderOpened />
                </el-icon>
              </el-button>
            </span>
          </el-tooltip>
        </span>
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
          <el-button size="small" type="primary" @click="progressPopover.close()">{{ t("common.confirm") }}</el-button>
        </div>
      </div>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpened } from "@element-plus/icons-vue";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { invoke } from "@/api/rpc";
import { listen } from "@/api/rpc";
import { useModal } from "@kabegame/core/composables/useModal";
import { useOrganizeStore, type OrganizeOptions } from "@/stores/organize";

/** 与后端 `OrganizeRunState` / `organize-progress` 字段一致 */
type OrganizeProgressState = {
  processedGlobal: number;
  libraryTotal: number;
  rangeStart: number | null;
  rangeEnd: number | null;
  removed: number;
  regenerated: number;
};

type OrganizeRunStatePayload = OrganizeProgressState & {
  running: boolean;
  dedupe: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  deleteSourceFiles: boolean;
};

const { t } = useI18n();
const loading = ref(false);
const organizeStore = useOrganizeStore();
const progressPopover = useModal();
const progress = ref<OrganizeProgressState>({
  processedGlobal: 0,
  libraryTotal: 0,
  rangeStart: null,
  rangeEnd: null,
  removed: 0,
  regenerated: 0,
});
const lastRunOptions = ref<OrganizeOptions | null>(null);

let unlistenProgress: (() => void) | undefined;
let unlistenFinished: (() => void) | undefined;

/** 区间模式：分母为所选终点 end（与对话框一致）；全量：分母为全库张数 */
const progressSummaryText = computed(() => {
  const p = progress.value;
  const rs = p.rangeStart;
  const re = p.rangeEnd;
  const g = p.processedGlobal;
  if (rs != null && re != null && re > rs) {
    const cur = Math.min(Math.max(g, rs), re);
    return t("gallery.organizingProgressRange", { current: cur, end: re });
  }
  if (p.libraryTotal > 0) {
    return t("gallery.organizingProgress", { processed: g, total: p.libraryTotal });
  }
  return t("gallery.organizingEllipsis");
});

const progressTooltipText = computed(() => {
  if (!loading.value) return "";
  const detail =
    progress.value.removed > 0 || progress.value.regenerated > 0
      ? ` ${t("gallery.organizingDetail", { removed: progress.value.removed, regenerated: progress.value.regenerated })}`
      : "";
  return `${progressSummaryText.value}${detail}`;
});

const progressPercentage = computed(() => {
  const p = progress.value;
  const rs = p.rangeStart;
  const re = p.rangeEnd;
  const g = p.processedGlobal;
  if (rs != null && re != null && re > rs) {
    const cur = Math.min(Math.max(g, rs), re);
    return Math.max(0, Math.min(100, Math.round((cur / re) * 100)));
  }
  if (p.libraryTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((g / p.libraryTotal) * 100)));
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

function applyProgressPayload(payload: Partial<OrganizeProgressState> & Record<string, unknown>) {
  const pg = payload.processedGlobal ?? payload.processed;
  const lt = payload.libraryTotal ?? payload.total;
  progress.value = {
    processedGlobal: typeof pg === "number" ? pg : progress.value.processedGlobal,
    libraryTotal: typeof lt === "number" ? lt : progress.value.libraryTotal,
    rangeStart: (payload.rangeStart as number | null | undefined) ?? null,
    rangeEnd: (payload.rangeEnd as number | null | undefined) ?? null,
    removed: typeof payload.removed === "number" ? payload.removed : progress.value.removed,
    regenerated: typeof payload.regenerated === "number" ? payload.regenerated : progress.value.regenerated,
  };
}

async function syncOrganizeRunStateFromBackend() {
  try {
    const s = await invoke<OrganizeRunStatePayload>("get_organize_run_state");
    if (!s.running) return;
    loading.value = true;
    applyProgressPayload(s);
    lastRunOptions.value = {
      dedupe: s.dedupe,
      removeMissing: s.removeMissing,
      removeUnrecognized: s.removeUnrecognized,
      regenThumbnails: s.regenThumbnails,
      deleteSourceFiles: s.deleteSourceFiles,
      rangeStart: s.rangeStart ?? null,
      rangeEnd: s.rangeEnd ?? null,
    };
    progressPopover.open();
  } catch {
    /* 无该命令或非桌面端 */
  }
}

onMounted(async () => {
  unlistenProgress = await listen<OrganizeProgressState>("organize-progress", (event) => {
    const p = event.payload;
    if (!p) return;
    applyProgressPayload(p);
  });

  unlistenFinished = await listen<{
    removed: number;
    regenerated: number;
    canceled: boolean;
  }>("organize-finished", (event) => {
    const p = event.payload;
    loading.value = false;
    progressPopover.close();
    lastRunOptions.value = null;
    progress.value = {
      processedGlobal: 0,
      libraryTotal: 0,
      rangeStart: null,
      rangeEnd: null,
      removed: 0,
      regenerated: 0,
    };
    if (p?.canceled) {
      ElMessage.info(t("gallery.organizeCanceled"));
      return;
    }
    ElMessage.success(t("gallery.organizeDone", { removed: p?.removed ?? 0, regenerated: p?.regenerated ?? 0 }));
  });

  await syncOrganizeRunStateFromBackend();
});

onUnmounted(() => {
  unlistenProgress?.();
  unlistenFinished?.();
});

// Gallery 确认整理后回传参数，这里真正启动整理（进度/popover 仍由本组件承载）
watch(
  () => organizeStore.pendingOptions,
  (opts) => {
    if (!opts) return;
    const consumed = organizeStore.consumeStart();
    if (consumed) void runOrganize(consumed);
  }
);

async function runOrganize(options: OrganizeOptions) {
  if (loading.value) return;
  try {
    loading.value = true;
    progressPopover.close();
    progress.value = {
      processedGlobal: 0,
      libraryTotal: 0,
      rangeStart: null,
      rangeEnd: null,
      removed: 0,
      regenerated: 0,
    };
    lastRunOptions.value = { ...options };
    await invoke("start_organize", {
      args: {
        dedupe: options.dedupe,
        removeMissing: options.removeMissing,
        removeUnrecognized: options.removeUnrecognized,
        regenThumbnails: options.regenThumbnails,
        deleteSourceFiles: options.deleteSourceFiles,
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
    progressPopover.toggle();
    return;
  }
  organizeStore.openDialog();
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

.organize-popover-ref,
.organize-tooltip-trigger {
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
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
