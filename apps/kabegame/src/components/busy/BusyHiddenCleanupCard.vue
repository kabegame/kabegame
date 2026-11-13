<template>
  <BusyTaskCard
    :icon="Trash2"
    :title="t('gallery.hiddenCleanupTitle')"
    :meta="`${store.progressPercentage}%`"
    :progress="store.progressPercentage"
    cancellable
    @cancel="hiddenCleanupService.cancel()"
  >
    <span class="shrink-0">
      {{ store.progress.processed.toLocaleString() }} / {{ store.progress.total.toLocaleString() }}
    </span>
    <span class="ml-auto min-w-0 truncate">
      {{ t("gallery.hiddenCleanupDetail", { removed: store.progress.removed }) }}
    </span>
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { Trash2 } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useHiddenCleanupStore } from "@/stores/hiddenCleanup";
import * as hiddenCleanupService from "@/services/hiddenCleanup";
import BusyTaskCard from "./BusyTaskCard.vue";

const { t } = useI18n();
const store = useHiddenCleanupStore();
</script>
