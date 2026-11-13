<template>
  <BusyTaskCard
    v-if="task"
    :icon="Database"
    :title="t('header.backfillTitle')"
    :subtitle="backfillName(task.id)"
    :meta="task.running ? `${percent}%` : t('header.backfillWaiting')"
    :progress="percent"
  >
    {{ task.processed.toLocaleString() }}
    <template v-if="task.total !== null">/ {{ task.total.toLocaleString() }}</template>
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import BusyTaskCard from "./BusyTaskCard.vue";
import { useI18n } from "@kabegame/i18n";
import { useBackfillStore } from "@/stores/backfill";
import { backfillName } from "@/utils/backfillName";

const props = defineProps<{ backfillId: string }>();
const { t } = useI18n();
const store = useBackfillStore();
const task = computed(() => store.tasks.get(props.backfillId) ?? null);
const percent = computed(() => {
  const current = task.value;
  if (!current || !current.total) return 0;
  return Math.max(0, Math.min(100, Math.round((current.processed / current.total) * 100)));
});
</script>
