<template>
  <article class="busy-task-card border-[rgba(59,130,246,0.22)] bg-[rgba(59,130,246,0.06)]">
    <div class="flex items-center gap-2">
      <el-icon class="shrink-0 text-[15px] text-[var(--anime-info)]"><Download /></el-icon>
      <span class="min-w-0 truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
        {{ t("updater.downloadingTitle") }}
      </span>
      <span class="ml-auto shrink-0 font-mono text-xs text-[#8b6b8f]">
        {{ store.downloadPercent }}%
      </span>
      <button
        type="button"
        class="busy-task-cancel"
        :title="t('common.cancel')"
        @click.stop="cancelDownload"
      >
        <el-icon class="text-[13px]"><Close /></el-icon>
      </button>
    </div>
    <div class="busy-bar-track">
      <span class="busy-bar-fill" :style="{ width: `${store.downloadPercent}%` }" />
    </div>
    <div class="font-mono text-xs text-[#8b6b8f]">{{ sizeText }}</div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Close, Download } from "@kabegame/element-plus-icons";
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
