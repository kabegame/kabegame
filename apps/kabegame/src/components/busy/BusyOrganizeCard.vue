<template>
  <BusyTaskCard
    :icon="FolderCog"
    :title="t('gallery.organizeGallery')"
    :meta="`${store.progressPercentage}%`"
    :progress="store.progressPercentage"
    cancellable
    @cancel="organizeService.cancel()"
  >
    <span class="shrink-0">
      {{ store.progress.processedGlobal.toLocaleString() }} / {{ store.progress.libraryTotal.toLocaleString() }}
    </span>
    <span class="ml-auto min-w-0 truncate">
      {{
        showPalettes
          ? t("gallery.organizingDetailWithPalette", {
              removed: store.progress.removed,
              regenerated: store.progress.regenerated,
              palettes: store.progress.palettesUpdated,
            })
          : t("gallery.organizingDetail", {
              removed: store.progress.removed,
              regenerated: store.progress.regenerated,
            })
      }}
    </span>
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FolderCog } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useOrganizeStore } from "@/stores/organize";
import * as organizeService from "@/services/organize";
import BusyTaskCard from "./BusyTaskCard.vue";

const { t } = useI18n();
const store = useOrganizeStore();

/** 本次勾了「重新计算代表色」才显示代表色计数 */
const showPalettes = computed(() => !!store.lastRunOptions?.recomputePalette || store.progress.palettesUpdated > 0);
</script>
