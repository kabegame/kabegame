<template>
  <Dialog
    v-model:open="open"
    :title="t('updater.downloadingTitle')"
    :width="420"
    :close-on-overlay="false"
    :hide-close="store.isDownloading"
  >
    <div class="pt-1">
      <Progress :value="percent" :tone="store.lastDownloadError ? 'danger' : 'accent'" :height="6" />
      <div class="mt-2.5 flex items-baseline justify-between gap-3 text-[12px] text-kb-fg-muted tabular-nums">
        <span>{{ sizeText }}</span>
        <span v-if="percent != null">{{ percent }}%</span>
      </div>
      <div v-if="store.lastDownloadError" class="mt-1.5 break-words text-[12px] text-kb-danger">
        {{ store.lastDownloadError }}
      </div>
    </div>

    <template #footer>
      <Button v-if="store.isDownloading" @click="onCancel">{{ t("common.cancel") }}</Button>
      <Button v-else variant="primary" @click="open = false">{{ t("common.close") }}</Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Button, Dialog, Progress } from "@/components/ui";
import { useI18n } from "@kabegame/i18n";
import * as updaterService from "@/services/updater";
import { useUpdaterStore } from "@/stores/updater";
import { messageBox } from "@/components/ui/messageBox";

const { t } = useI18n();
const store = useUpdaterStore();

/** 由后端 phase 驱动开合（见下）；下载中隐藏 ×、点遮罩不关，Esc / Android 返回只收起弹窗、不取消下载 */
const open = ref(false);

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/** 下载中还不知道总大小时是不定进度（原来显示成一直 0%） */
const percent = computed(() => (store.isDownloading && !store.totalBytes ? null : store.downloadPercent));

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
      open.value = true;
      return;
    }
    if (prev === "downloading") {
      if (now === "restartable") {
        open.value = false;
        void promptRestart();
      } else if (now === "updateAvailable") {
        // 失败：留弹窗展示错误；取消：直接关
        if (!store.lastDownloadError) open.value = false;
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
    await messageBox.confirm(t("updater.restartReadyMessage"), t("updater.restartReadyTitle"), {
      confirmButtonText: t("updater.restartNow"),
      cancelButtonText: t("updater.restartLater"),
      type: "success",
    });
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
