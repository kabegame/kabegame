<template>
  <BusyTaskCard
    :icon="Download"
    :title="t('updater.downloadingTitle')"
    :meta="`${store.downloadPercent}%`"
    :progress="store.downloadPercent"
    cancellable
    @cancel="cancelDownload"
  >
    {{ sizeText }}
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Download } from "@lucide/vue";
import BusyTaskCard from "./BusyTaskCard.vue";
import { useI18n } from "@kabegame/i18n";
import { useUpdaterStore } from "@/stores/updater";
import { formatBytes } from "@/utils/formatBytes";
import * as updaterService from "@/services/updater";

const { t } = useI18n();
const store = useUpdaterStore();
const sizeText = computed(() => {
  const downloaded = formatBytes(store.downloadedBytes);
  return store.totalBytes ? `${downloaded} / ${formatBytes(store.totalBytes)}` : downloaded;
});

async function cancelDownload() {
  try {
    await updaterService.cancelDownload();
  } catch (error) {
    console.warn("[updater] cancel failed:", error);
  }
}
</script>
