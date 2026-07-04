<template>
  <div v-if="progress.active" class="schedule-progress-wrap" :aria-label="ariaLabel">
    <el-progress
      :percentage="displayPercentClamped"
      :stroke-width="8"
      :show-text="false"
      :duration="lineDuration"
      class="schedule-progress"
    />
    <el-countdown
      class="schedule-countdown"
      format="HH:mm:ss"
      :value="countdownDeadlineMs"
    >
      <template #prefix>
        <span class="countdown-prefix">{{ t("autoConfig.progress.countdownPrefix") }}</span>
      </template>
    </el-countdown>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import type { RunConfig } from "../../stores/crawler";
import { useScheduleProgress } from "../../composables/useScheduleProgress";

const props = defineProps<{
  config: RunConfig;
}>();

const { t } = useI18n();
const progress = useScheduleProgress(toRef(props, "config"));

/** 与 `remaining`（秒）对应的绝对时刻，供 el-countdown 使用 */
const countdownDeadlineMs = computed(() => {
  const p = progress.value;
  if (!p.active) return Date.now();
  return Date.now() + Math.max(0, p.remaining) * 1000;
});

const ariaLabel = computed(() => t("autoConfig.progress.ariaLabel"));

/** 展示用百分比；定时刚开启时从 0 动画到真实值 */
const displayPercent = ref(0);
/** el-progress 宽度过渡时长（秒）。平时为 0 以便每秒 tick 不拖尾；开启瞬间用短动画 */
const lineDuration = ref(0);

const targetPercentInt = computed(() =>
  progress.value.active ? Math.min(100, Math.max(0, Math.round(progress.value.percent * 100))) : 0,
);

const displayPercentClamped = computed(() =>
  Math.min(100, Math.max(0, Math.round(displayPercent.value))),
);

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
      lineDuration.value = 0;
      displayPercent.value = 0;
      enableAnimating = false;
      return;
    }

    const turnedOn = prev != null && prev.on === false && cur.on === true;
    if (turnedOn) {
      enableAnimating = true;
      lineDuration.value = 0.45;
      displayPercent.value = 0;
      nextTick(() => {
        requestAnimationFrame(() => {
          displayPercent.value = cur.target;
        });
      });
      window.setTimeout(() => {
        lineDuration.value = 0;
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

<style scoped lang="scss">
.schedule-progress-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.schedule-progress {
  flex: 1;
  min-width: 120px;
}

.schedule-countdown {
  flex-shrink: 0;
  line-height: 1.2;

  :deep(.el-statistic) {
    display: inline-flex;
    flex-direction: row;
    align-items: baseline;
    flex-wrap: nowrap;
    gap: 4px;
  }

  :deep(.el-statistic__head) {
    display: none;
  }

  :deep(.el-statistic__content) {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--anime-text-secondary);
  }

  :deep(.el-statistic__number) {
    font-size: 12px;
    font-weight: 500;
    color: var(--anime-text-secondary);
  }
}

.countdown-prefix {
  font-size: 12px;
  color: var(--anime-text-secondary);
  white-space: pre;
}
</style>
