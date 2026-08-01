<template>
  <article class="busy-task-card border-[rgba(239,108,108,0.24)] bg-[rgba(239,108,108,0.08)]">
    <div class="flex items-center gap-2">
      <el-icon class="shrink-0 text-[15px] text-[var(--anime-danger)]"><Delete /></el-icon>
      <span class="min-w-0 truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
        {{ t("gallery.hiddenCleanupTitle") }}
      </span>
      <span class="ml-auto shrink-0 font-mono text-xs text-[#8b6b8f]">
        {{ store.progressPercentage }}%
      </span>
      <button
        type="button"
        class="busy-task-cancel"
        :title="t('common.cancel')"
        @click.stop="hiddenCleanupService.cancel()"
      >
        <el-icon class="text-[13px]"><Close /></el-icon>
      </button>
    </div>
    <div class="busy-bar-track">
      <span class="busy-bar-fill" :style="{ width: `${store.progressPercentage}%` }" />
    </div>
    <div class="flex items-center gap-2.5 text-xs text-[#8b6b8f]">
      <span class="shrink-0 font-mono">
        {{ store.progress.processed.toLocaleString() }} / {{ store.progress.total.toLocaleString() }}
      </span>
      <span class="ml-auto min-w-0 truncate">
        {{ t("gallery.hiddenCleanupDetail", { removed: store.progress.removed }) }}
      </span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { Close, Delete } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useHiddenCleanupStore } from "@/stores/hiddenCleanup";
import * as hiddenCleanupService from "@/services/hiddenCleanup";

const { t } = useI18n();
const store = useHiddenCleanupStore();
</script>
