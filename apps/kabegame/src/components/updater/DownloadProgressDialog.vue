<template>
  <el-dialog
    :model-value="isOpen"
    :z-index="zIndex"
    :title="t('updater.downloadingTitle')"
    width="420px"
    append-to-body
    :close-on-click-modal="false"
    :show-close="!store.isDownloading"
    class="download-progress-dialog"
    @update:model-value="v => { if (!v) close() }"
  >
    <div class="dl-body">
      <el-progress
        :percentage="store.downloadPercent"
        :status="store.lastDownloadError ? 'exception' : undefined"
        :stroke-width="14"
      />
      <div class="dl-meta">
        <span>{{ sizeText }}</span>
        <span v-if="store.lastDownloadError" class="dl-error">{{ store.lastDownloadError }}</span>
      </div>
    </div>

    <template #footer>
      <el-button v-if="store.isDownloading" @click="onCancel">{{ t('common.cancel') }}</el-button>
      <el-button v-else type="primary" @click="close()">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { ElButton, ElDialog, ElMessageBox, ElProgress } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "@kabegame/core/composables/useModal";
import * as updaterService from "@/services/updater";
import { useUpdaterStore } from "@/stores/updater";

const { t } = useI18n();
const store = useUpdaterStore();

const { isOpen, zIndex, open, close } = useModal();

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

const sizeText = computed(() => {
  const total = store.totalBytes;
  const got = formatBytes(store.downloadedBytes);
  return total ? `${got} / ${formatBytes(total)}` : got;
});

// 由后端 phase 驱动弹窗开合 + 成功后提示重启
watch(
  () => store.phase,
  (now, prev) => {
    if (now === "downloading") {
      open();
      return;
    }
    if (prev === "downloading") {
      if (now === "restartable") {
        close();
        void promptRestart();
      } else if (now === "updateAvailable") {
        // 失败：留弹窗展示错误；取消：直接关
        if (!store.lastDownloadError) close();
      }
    }
  },
);

async function onCancel() {
  try {
    await updaterService.cancelDownload();
  } catch (e) {
    console.warn("[updater] cancel failed:", e);
  }
}

async function promptRestart() {
  try {
    await ElMessageBox.confirm(
      t("updater.restartReadyMessage"),
      t("updater.restartReadyTitle"),
      {
        confirmButtonText: t("updater.restartNow"),
        cancelButtonText: t("updater.restartLater"),
        type: "success",
      },
    );
  } catch {
    return; // 稍后重启
  }
  try {
    await updaterService.applyUpdateAndRestart();
  } catch (e) {
    console.warn("[updater] apply update failed:", e);
  }
}
</script>

<style scoped lang="scss">
.dl-body {
  padding: 4px 2px 0;
}

.dl-meta {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--anime-text-secondary);

  .dl-error {
    color: var(--el-color-danger);
    word-break: break-word;
  }
}
</style>
