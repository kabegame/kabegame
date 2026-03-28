import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import type { RunConfig } from "../stores/crawler";

type ScheduleProgress = {
  percent: number;
  remaining: number;
  total: number;
  active: boolean;
};

const nowInSecs = () => Math.floor(Date.now() / 1000);

const tsToSecs = (ts?: number) => {
  if (!ts) return 0;
  return ts > 9_999_999_999 ? Math.floor(ts / 1000) : Math.floor(ts);
};

const getScheduleTotal = (config: RunConfig): number => {
  const s = config.scheduleSpec;
  switch (s?.mode) {
    case "interval":
      return Math.max(0, Number(s.intervalSecs ?? 0));
    case "daily":
      return s.hour === -1 ? 3600 : 86400;
    case "weekly":
      return 604800;
    default:
      return 0;
  }
};

/** 基于「下一次触发 planned_at」与周期 total 的倒计时进度（与后端 planned_at 语义一致） */
const getScheduleProgressParts = (config: RunConfig, nowSecs: number) => {
  const total = getScheduleTotal(config);
  const planned = tsToSecs(config.schedulePlannedAt);
  if (total <= 0 || !planned) {
    return { percent: 0, remaining: 0, total: 0 };
  }
  const remaining = Math.max(0, planned - nowSecs);
  const cycleStart = planned - total;
  const elapsed = Math.min(total, Math.max(0, nowSecs - cycleStart));
  const percent = Math.min(1, Math.max(0, elapsed / total));
  return { percent, remaining, total };
};

export function useScheduleProgress(
  config: Ref<RunConfig>,
): Readonly<Ref<ScheduleProgress>> {
  const nowSecs = ref(nowInSecs());
  let timer: number | null = null;

  const resetNow = () => {
    nowSecs.value = nowInSecs();
  };

  onMounted(() => {
    resetNow();
    timer = window.setInterval(() => {
      nowSecs.value = nowInSecs();
    }, 1000);
  });

  onUnmounted(() => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  });

  watch(
    () => [
      JSON.stringify(config.value.scheduleSpec),
      config.value.schedulePlannedAt,
      config.value.scheduleLastRunAt,
      config.value.scheduleEnabled,
    ],
    () => {
      resetNow();
    },
  );

  return computed(() => {
    const cfg = config.value;
    const active = !!cfg.scheduleEnabled && !!cfg.scheduleSpec?.mode;
    if (!active) {
      return { percent: 0, remaining: 0, total: 0, active };
    }
    const { percent, remaining, total } = getScheduleProgressParts(
      cfg,
      nowSecs.value,
    );
    if (total <= 0) {
      return { percent: 0, remaining: 0, total: 0, active: false };
    }
    return { percent, remaining, total, active: true };
  });
}
