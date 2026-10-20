import type { ScheduleSpec } from "@/stores/crawler";

/** 复制定时规则。传入的常是 reactive 代理，structuredClone 克隆代理会抛 DataCloneError */
export function cloneScheduleSpec(spec: ScheduleSpec): ScheduleSpec {
  return spec.mode === "weekly" ? { ...spec, weekdays: [...spec.weekdays] } : { ...spec };
}

type Translate = (key: string, params?: Record<string, unknown>) => string;
const pad = (value: number) => String(value).padStart(2, "0");

/** 卡片 chip 用的短格式：「每天 09:05」「工作日 08:30」「每周一、三 20:00」「每小时 :30」「每 6 小时」 */
export function specShortText(spec: ScheduleSpec | null | undefined, t: Translate): string {
  if (!spec) return t("autoConfig.mode_none");
  if (spec.mode === "interval") {
    const seconds = spec.intervalSecs;
    if (seconds % 86400 === 0) return t("autoConfig.specEveryDays", { n: seconds / 86400 });
    if (seconds % 3600 === 0) return t("autoConfig.specEveryHours", { n: seconds / 3600 });
    return t("autoConfig.specEveryMinutes", { n: Math.max(1, Math.round(seconds / 60)) });
  }
  if (spec.mode === "hourly") return t("autoConfig.specHourly", { minute: pad(spec.minute) });
  const time = `${pad(spec.hour)}:${pad(spec.minute)}`;
  if (spec.mode === "daily") return t("autoConfig.specDaily", { time });
  const days = [...new Set(spec.weekdays)].sort((a, b) => a - b);
  const key = days.join(",");
  if (days.length === 7) return t("autoConfig.specDaily", { time });
  if (key === "0,1,2,3,4") return t("autoConfig.specWorkdays", { time });
  if (key === "5,6") return t("autoConfig.specWeekend", { time });
  const labels = days.map((day) => t(`autoConfig.weekdayShort${day}`)).join(t("autoConfig.weekdaySeparator"));
  return t("autoConfig.specWeekly", { weekday: labels, time });
}

export function specText(spec: ScheduleSpec | null | undefined, t: Translate): string {
  if (!spec) return t("autoConfig.manualOnly");
  if (spec.mode === "interval") {
    const seconds = spec.intervalSecs;
    if (seconds % 86400 === 0) return t("autoConfig.everyDays", { n: seconds / 86400 });
    if (seconds % 3600 === 0) return t("autoConfig.everyHours", { n: seconds / 3600 });
    return t("autoConfig.everyMinutes", { n: Math.max(1, Math.round(seconds / 60)) });
  }
  if (spec.mode === "hourly") return t("autoConfig.hourlyAt", { minute: pad(spec.minute) });
  if (spec.mode === "daily") return t("autoConfig.dailyAt", { hour: pad(spec.hour), minute: pad(spec.minute) });
  const days = [...spec.weekdays].sort((a, b) => a - b);
  const labels = days.map((day) => t(`autoConfig.weekday${day}`)).join(t("autoConfig.weekdaySeparator"));
  return t("autoConfig.weeklyAt", { weekday: labels, hour: pad(spec.hour), minute: pad(spec.minute) });
}

export function dayLabel(timestamp: number, t: Translate, now = new Date()): string {
  const date = new Date(timestamp);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - start.getTime()) / 86400000);
  if (days === -1) return t("autoConfig.yesterday");
  if (days === 0) return t("autoConfig.today");
  if (days === 1) return t("autoConfig.tomorrow");
  if (days === 2) return t("autoConfig.dayAfterTomorrow");
  if (days > 2 && days < 7) return t(`autoConfig.weekday${(date.getDay() + 6) % 7}`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatRunTime(timestamp: number, t: Translate, now = new Date()): string {
  const date = new Date(timestamp);
  return `${dayLabel(timestamp, t, now)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function relTime(timestamp: number, t: Translate, now = Date.now()): string {
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const n =
    absolute < 60000
      ? 1
      : absolute < 3600000
        ? Math.round(absolute / 60000)
        : absolute < 86400000
          ? Math.round(absolute / 3600000)
          : Math.round(absolute / 86400000);
  const unit =
    absolute < 3600000
      ? t("autoConfig.unitMinutes")
      : absolute < 86400000
        ? t("autoConfig.unitHours")
        : t("autoConfig.unitDays");
  return t(delta >= 0 ? "autoConfig.relativeAfter" : "autoConfig.relativeBefore", { n, unit });
}

export function previewNextRuns(spec: ScheduleSpec | null | undefined, count = 3, now = new Date()): number[] {
  if (!spec) return [];
  const result: number[] = [];
  let cursor = now.getTime();
  for (let index = 0; index < count; index++) {
    let next: number | null = null;
    if (spec.mode === "interval") next = cursor + spec.intervalSecs * 1000;
    else if (spec.mode === "hourly") {
      const date = new Date(cursor);
      date.setSeconds(0, 0);
      date.setMinutes(spec.minute);
      if (date.getTime() <= cursor) date.setHours(date.getHours() + 1);
      next = date.getTime();
    } else {
      for (let day = 0; day <= 7; day++) {
        const date = new Date(cursor);
        date.setDate(date.getDate() + day);
        date.setHours(spec.hour, spec.minute, 0, 0);
        if (date.getTime() <= cursor) continue;
        if (spec.mode === "daily" || spec.weekdays.includes((date.getDay() + 6) % 7)) {
          next = date.getTime();
          break;
        }
      }
    }
    if (next == null) break;
    result.push(next);
    cursor = next;
  }
  return result;
}
