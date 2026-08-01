<template>
  <article class="busy-task-card border-[rgba(255,107,157,0.24)] bg-[rgba(255,107,157,0.08)]">
    <div class="flex items-center gap-2">
      <el-icon class="shrink-0 text-[15px] text-[var(--anime-primary-dark)]"><FolderOpened /></el-icon>
      <span class="min-w-0 truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
        {{ t("gallery.organizeGallery") }}
      </span>
      <span class="ml-auto shrink-0 font-mono text-xs text-[#8b6b8f]">
        {{ store.progressPercentage }}%
      </span>
      <button
        type="button"
        class="busy-task-cancel"
        :title="t('common.cancel')"
        @click.stop="organizeService.cancel()"
      >
        <el-icon class="text-[13px]"><Close /></el-icon>
      </button>
    </div>
    <div class="busy-bar-track">
      <span class="busy-bar-fill" :style="{ width: `${store.progressPercentage}%` }" />
    </div>
    <div class="flex items-center gap-2.5 text-xs text-[#8b6b8f]">
      <span class="shrink-0 font-mono">
        {{ store.progress.processedGlobal.toLocaleString() }} / {{ store.progress.libraryTotal.toLocaleString() }}
      </span>
      <span class="ml-auto min-w-0 truncate">
        {{ t("gallery.organizingDetail", {
          removed: store.progress.removed,
          regenerated: store.progress.regenerated,
        }) }}
      </span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { Close, FolderOpened } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useOrganizeStore } from "@/stores/organize";
import * as organizeService from "@/services/organize";

const { t } = useI18n();
const store = useOrganizeStore();
</script>
