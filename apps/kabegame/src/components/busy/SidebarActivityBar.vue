<template>
  <el-popover
    :visible="panelVisible"
    trigger="manual"
    placement="top-start"
    :width="300"
    :offset="8"
    popper-class="sidebar-activity-popover"
    @update:visible="(value: boolean) => (panelVisible = value)"
  >
    <template #reference>
      <button
        type="button"
        class="relative appearance-none border border-solid rounded-xl cursor-pointer overflow-hidden transition-colors"
        :class="[
          collapsed ? 'h-10 w-10 mx-auto grid place-items-center p-0' : 'w-full flex flex-col gap-2 px-3 py-2.5',
          hasUnseenFailure
            ? 'border-[var(--anime-danger)] bg-[rgba(239,68,68,0.08)]'
            : 'border-[rgba(255,107,157,0.34)] bg-[rgba(255,255,255,0.85)] hover:bg-[rgba(255,107,157,0.08)]',
        ]"
        @click="togglePanel"
      >
        <template v-if="collapsed">
          <span
            class="activity-ring grid h-7 w-7 place-items-center rounded-full text-[10px] font-700 text-[var(--anime-primary-dark)]"
            :class="{ 'is-failure': hasUnseenFailure, 'is-indeterminate': summaryPercent === null && count > 0 }"
            :style="ringStyle"
          >
            <span class="relative z-1">{{ count }}</span>
          </span>
        </template>
        <template v-else>
          <div class="flex w-full items-center gap-1.5 text-xs">
            <el-icon
              class="text-[13px]"
              :class="hasUnseenFailure ? 'text-[var(--anime-danger)]' : 'text-[var(--anime-primary-dark)]'"
            >
              <Loading v-if="!hasUnseenFailure" class="busy-spin" />
              <WarningFilled v-else />
            </el-icon>
            <span
              class="font-700"
              :class="hasUnseenFailure ? 'text-[var(--anime-danger)]' : 'text-[var(--anime-text-primary)]'"
            >
              {{ t("header.busyBackground", { count }) }}
            </span>
            <span v-if="summaryPercent !== null" class="ml-auto font-mono text-[11px] text-[var(--anime-text-muted)]">
              {{ summaryPercent }}%
            </span>
          </div>
          <span
            class="activity-line-track block w-full"
            :class="{ 'is-failure': hasUnseenFailure }"
          >
            <span
              class="activity-line"
              :class="{ 'is-indeterminate': summaryPercent === null && count > 0 }"
              :style="lineStyle"
            />
          </span>
        </template>
      </button>
    </template>

    <div class="flex max-h-[60vh] flex-col overflow-y-auto">
      <BusyTasksSection @close="panelVisible = false">
        <template #extra>
          <button
            type="button"
            class="appearance-none border-0 bg-transparent p-0 cursor-pointer text-xs font-600 text-[var(--anime-primary-dark)] hover:opacity-75"
            @click="cancelAll"
          >
            {{ t("header.busyCancelAll") }}
          </button>
        </template>
      </BusyTasksSection>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Loading, WarningFilled } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { useBusyTasks } from "@/composables/useBusyTasks";
import BusyTasksSection from "./BusyTasksSection.vue";

defineProps<{ collapsed: boolean }>();
const { t } = useI18n();
const panelVisible = ref(false);
useModalBack(panelVisible);

const {
  count,
  summaryPercent,
  hasUnseenFailure,
  markFailuresSeen,
  cancelAll,
} = useBusyTasks();

const ringStyle = computed(() => ({
  "--activity-angle": `${Math.max(0, summaryPercent.value ?? 0) * 3.6}deg`,
}));
const lineStyle = computed(() => ({
  "--activity-width": `${Math.max(0, summaryPercent.value ?? 0)}%`,
}));

function togglePanel() {
  panelVisible.value = !panelVisible.value;
  if (panelVisible.value) markFailuresSeen();
}
</script>

<style scoped>
/* 折叠态小进度环：粉色填充 + 浅紫轨道，中心白底数字（对齐徽章样式） */
.activity-ring {
  --activity-color: var(--anime-primary);

  position: relative;
}

.activity-ring::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: conic-gradient(
    var(--activity-color) var(--activity-angle),
    rgba(167, 139, 250, 0.28) 0
  );
}

.activity-ring::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.96);
}

.activity-ring.is-indeterminate::before {
  background: repeating-conic-gradient(
    var(--activity-color) 0deg 26deg,
    transparent 26deg 48deg
  );
  animation: busy-ring-spin 1.1s linear infinite;
}

.activity-ring.is-failure {
  --activity-color: var(--anime-danger);
}

.activity-ring.is-failure::before {
  background: var(--activity-color);
  animation: none;
}

/* 展开态细进度线：浅紫轨道 + 粉紫渐变填充（对齐设计稿） */
.activity-line-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(167, 139, 250, 0.22);
  overflow: hidden;
}

.activity-line {
  display: block;
  height: 100%;
  width: var(--activity-width);
  border-radius: 2px;
  background: linear-gradient(90deg, var(--anime-primary), var(--anime-secondary));
  transition: width 0.25s ease;
}

.activity-line-track.is-failure .activity-line {
  background: var(--anime-danger);
}

.activity-line.is-indeterminate {
  width: 42%;
  animation: busy-line-flow 1.2s ease-in-out infinite;
}

.busy-spin {
  animation: busy-ring-spin 1.4s linear infinite;
}

@keyframes busy-ring-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes busy-line-flow {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(350%);
  }
}
</style>
