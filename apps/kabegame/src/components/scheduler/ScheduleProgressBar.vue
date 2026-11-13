<template>
  <div v-if="progress.active" class="mt-2 flex items-center gap-2.5" :aria-label="ariaLabel">
    <Progress :value="displayPercentClamped" :height="6" class="min-w-[120px] flex-1" />
    <span class="flex-none whitespace-pre text-[12px] font-500 tabular-nums text-kb-fg-muted">
      {{ t("autoConfig.progress.countdownPrefix") }}{{ countdownText }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Progress } from "@/components/ui";
import type { RunConfig } from "../../stores/crawler";
import { useScheduleProgress } from "../../composables/useScheduleProgress";

const props = defineProps<{
  config: RunConfig;
}>();

const { t } = useI18n();
const progress = useScheduleProgress(toRef(props, "config"));

/** 剩余时间 `HH:mm:ss`（小时不按天折叠，与原 el-countdown 的 HH 一致）；remaining 每秒更新 */
const countdownText = computed(() => {
  const total = Math.max(0, Math.floor(progress.value.remaining));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
});

const ariaLabel = computed(() => t("autoConfig.progress.ariaLabel"));

/** 展示用百分比；定时刚开启时从 0 动画到真实值 */
const displayPercent = ref(0);

const targetPercentInt = computed(() =>
  progress.value.active ? Math.min(100, Math.max(0, Math.round(progress.value.percent * 100))) : 0,
);

const displayPercentClamped = computed(() => Math.min(100, Math.max(0, Math.round(displayPercent.value))));

/** 正在播放「开启定时」进度条动画时，不同步 tick，避免打断过渡 */
let enableAnimating = false;

watch(
  () => ({
    on: props.config.scheduleEnabled,
    target: targetPercentInt.value,
    active: progress.value.active,
  }),
  (cur, prev) => {
    if (!cur.on || !cur.active) {
      displayPercent.value = 0;
      enableAnimating = false;
      return;
    }

    const turnedOn = prev != null && prev.on === false && cur.on === true;
    if (turnedOn) {
      enableAnimating = true;
      displayPercent.value = 0;
      nextTick(() => {
        requestAnimationFrame(() => {
          displayPercent.value = cur.target;
        });
      });
      window.setTimeout(() => {
        displayPercent.value = cur.target;
        enableAnimating = false;
      }, 500);
      return;
    }

    if (enableAnimating) return;
    displayPercent.value = cur.target;
  },
  { flush: "post" },
);
</script>
