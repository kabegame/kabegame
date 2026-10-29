<template>
  <article v-if="task" class="busy-task-card border-[rgba(167,139,250,0.28)] bg-[rgba(167,139,250,0.08)]">
    <div class="flex items-center gap-2">
      <el-icon class="shrink-0 text-[15px] text-[var(--anime-secondary)]"><Coin /></el-icon>
      <div class="min-w-0 flex-1 flex flex-col gap-0.5">
        <span class="truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
          {{ t("header.backfillTitle") }}
        </span>
        <span class="truncate text-xs text-[#8b6b8f]">{{ backfillName(task.id) }}</span>
      </div>
      <span class="ml-auto shrink-0 font-mono text-xs text-[#8b6b8f]">
        {{ task.running ? `${percent}%` : t("header.backfillWaiting") }}
      </span>
    </div>
    <div class="busy-bar-track">
      <span class="busy-bar-fill" :style="{ width: `${percent}%` }" />
    </div>
    <div class="font-mono text-xs text-[#8b6b8f]">
      {{ task.processed.toLocaleString() }}
      <template v-if="task.total !== null">/ {{ task.total.toLocaleString() }}</template>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Coin } from "@kabegame/element-plus-icons";
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
