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

/** 每周多选日期时，本周期从上一个选中日的同一时刻算起，而不是固定 7 天 */
const getWeeklyTotal = (weekdays: number[], plannedSecs: number): number => {
  const planned = new Date(plannedSecs * 1000);
  for (let day = 1; day <= 7; day++) {
    const prev = new Date(planned);
    prev.setDate(prev.getDate() - day);
    if (weekdays.includes((prev.getDay() + 6) % 7)) return plannedSecs - Math.floor(prev.getTime() / 1000);
  }
  return 604800;
};

const getScheduleTotal = (config: RunConfig, plannedSecs: number): number => {
  const s = config.scheduleSpec;
  switch (s?.mode) {
    case "interval":
      return Math.max(0, Number(s.intervalSecs ?? 0));
    case "hourly":
      return 3600;
    case "daily":
      return 86400;
    case "weekly":
      return getWeeklyTotal(s.weekdays, plannedSecs);
    default:
      return 0;
  }
};

/** 基于「下一次触发 planned_at」与周期 total 的倒计时进度（与后端 planned_at 语义一致） */
const getScheduleProgressParts = (config: RunConfig, nowSecs: number) => {
  const planned = tsToSecs(config.schedulePlannedAt);
  const total = getScheduleTotal(config, planned);
  if (total <= 0 || !planned) {
    return { percent: 0, remaining: 0, total: 0 };
  }
  const remaining = Math.max(0, planned - nowSecs);
  const cycleStart = planned - total;
  const elapsed = Math.min(total, Math.max(0, nowSecs - cycleStart));
  const percent = Math.min(1, Math.max(0, elapsed / total));
  return { percent, remaining, total };
};

export function useScheduleProgress(config: Ref<RunConfig>): Readonly<Ref<ScheduleProgress>> {
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
    const { percent, remaining, total } = getScheduleProgressParts(cfg, nowSecs.value);
    if (total <= 0) {
      return { percent: 0, remaining: 0, total: 0, active: false };
    }
    return { percent, remaining, total, active: true };
  });
}
