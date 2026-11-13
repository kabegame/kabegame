<template>
  <Popover v-model:open="panelVisible">
    <Tooltip :content="panelVisible ? '' : t('header.busyBackground', { count })" side="right">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="relative box-border grid size-10 cursor-pointer place-items-center rounded-kb-md border-0 p-0 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring"
          :class="
            hasUnseenFailure
              ? 'bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)]'
              : 'bg-transparent hover:bg-kb-hover data-[state=open]:bg-kb-pressed'
          "
          :aria-label="t('header.busyBackground', { count })"
        >
          <span
            class="activity-ring grid size-7 place-items-center rounded-full text-[10px] font-700 tabular-nums"
            :class="[
              hasUnseenFailure ? 'is-failure text-kb-danger' : 'text-kb-fg',
              { 'is-indeterminate': summaryPercent === null && count > 0 },
            ]"
            :style="ringStyle"
          >
            <span class="relative z-1">{{ count }}</span>
          </span>
        </button>
      </PopoverTrigger>
    </Tooltip>
    <PopoverContent side="right" align="end" :side-offset="10" :width="300">
      <BusyTasksSection @close="panelVisible = false">
        <template #extra>
          <Button variant="ghost" size="sm" class="-mr-1" @click="cancelAll">
            {{ t("header.busyCancelAll") }}
          </Button>
        </template>
      </BusyTasksSection>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui";
import { useBusyTasks } from "@/composables/useBusyTasks";
import BusyTasksSection from "./BusyTasksSection.vue";

const { t } = useI18n();
const panelVisible = ref(false);

const { count, summaryPercent, hasUnseenFailure, markFailuresSeen, cancelAll } = useBusyTasks();

watch(panelVisible, (open) => {
  if (open) markFailuresSeen();
});

const ringStyle = computed(() => ({
  "--activity-angle": `${Math.max(0, summaryPercent.value ?? 0) * 3.6}deg`,
}));
</script>

<style scoped>
/* 小进度环：强调色填充 + 浅灰轨道，中心白底数字 */
.activity-ring {
  --activity-color: var(--kb-accent);

  position: relative;
}

.activity-ring::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: conic-gradient(var(--activity-color) var(--activity-angle), var(--kb-fill-dark) 0);
}

.activity-ring::after {
  content: "";
  position: absolute;
  inset: 2.5px;
  border-radius: 999px;
  background: var(--kb-surface-raised);
}

.activity-ring.is-indeterminate::before {
  background: conic-gradient(var(--activity-color) 0deg 90deg, var(--kb-fill-dark) 90deg);
  animation: busy-ring-spin 1.1s linear infinite;
}

.activity-ring.is-failure {
  --activity-color: var(--kb-danger);
}

.activity-ring.is-failure::before {
  background: var(--activity-color);
  animation: none;
}

@keyframes busy-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .activity-ring.is-indeterminate::before {
    animation: none;
  }
}
</style>
