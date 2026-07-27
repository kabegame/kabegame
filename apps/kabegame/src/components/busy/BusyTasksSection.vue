<template>
  <section class="flex flex-col gap-2 px-1 py-1">
    <div class="flex items-center justify-between gap-2 px-1">
      <span class="text-[13px] font-700 text-[var(--anime-text-primary)]">
        {{ t("header.busyTitle") }}
      </span>
      <!-- 宿主可在标题右侧放操作（如活动条面板的「全部取消」） -->
      <slot name="extra" />
    </div>
    <div class="flex flex-col gap-1.5">
      <template v-for="card in cards" :key="card.kind === 'folderSync' ? `${card.kind}-${card.albumId}` : card.kind">
        <BusyOrganizeCard v-if="card.kind === 'organize'" />
        <BusyHiddenCleanupCard v-else-if="card.kind === 'hiddenCleanup'" />
        <BusyFolderSyncCard
          v-else-if="card.kind === 'folderSync'"
          :album-id="card.albumId"
          @close="emit('close')"
        />
        <BusyUpdaterCard v-else />
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from "@kabegame/i18n";
import { useBusyTasks } from "@/composables/useBusyTasks";
import BusyOrganizeCard from "./BusyOrganizeCard.vue";
import BusyHiddenCleanupCard from "./BusyHiddenCleanupCard.vue";
import BusyFolderSyncCard from "./BusyFolderSyncCard.vue";
import BusyUpdaterCard from "./BusyUpdaterCard.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const { cards } = useBusyTasks();
</script>
