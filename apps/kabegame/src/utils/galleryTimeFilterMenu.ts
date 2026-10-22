/**
 * 画廊「按时间」过滤的展示文案：年 / 月 / 日行标签与当前日期过滤的详情。
 */

/** `@kabegame/i18n` / `useI18n().t`（仅用于时间菜单文案） */
export type TimeMenuTranslateFn = (key: string, values?: Record<string, string | number>) => string;

/** 构建树时注入「全年」「全月」及月/日展示格式（i18n） */
export interface TimeMenuScopeLabels {
  fullYear: string;
  fullMonth: string;
  /** 「2025 全年」等 */
  labelFullYearRow: (year: string) => string;
  labelMonthRow: (yearMonth: string) => string;
  labelDayRow: (ymd: string) => string;
}

/** 调用方传入 `t` 与当前 `locale`。 */
export function buildTimeMenuScopeLabels(t: TimeMenuTranslateFn, locale: string): TimeMenuScopeLabels {
  return {
    fullYear: t("gallery.timeScopeFullYear"),
    fullMonth: t("gallery.timeScopeFullMonth"),
    labelFullYearRow: (year: string) =>
      t("gallery.timeScopeFullYearRow", {
        year,
        scope: t("gallery.timeScopeFullYear"),
      }),
    labelMonthRow: (ym: string) => formatTimeMenuMonthRow(ym, locale, t),
    labelDayRow: (ymd: string) => formatTimeMenuDayRow(ymd, locale, t),
  };
}

/** 英文日期序数：1st, 2nd, 3rd, 4th… */
export function englishOrdinalDay(n: number): string {
  const k = n % 100;
  if (k >= 11 && k <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * 月行展示：`YYYY-MM` → 简中/繁中「03月」、英「Jan」等（避免裸数字 1/2/3 歧义）。
 */
export function formatTimeMenuMonthRow(yearMonth: string, locale: string, t: TimeMenuTranslateFn): string {
  const y = Number(yearMonth.slice(0, 4));
  const mm = yearMonth.slice(5, 7);
  const mNum = Number(mm);
  const d = new Date(y, mNum - 1, 1);

  if (locale === "zh" || locale === "zhtw") {
    return t("gallery.timeScopeMonthWithUnit", { mm });
  }
  if (locale === "ja") {
    return t("gallery.timeScopeMonthWithUnitJa", { n: mNum });
  }
  if (locale === "ko") {
    return t("gallery.timeScopeMonthWithUnitKo", { n: mNum });
  }
  // 英语等：短月份名（Jan / Feb / Mar…）
  return new Intl.DateTimeFormat("en-US", { month: "short" }).format(d);
}

/**
 * 日行展示：简中/繁中「15日」、英序数 1st / 2nd / 3rd…
 */
export function formatTimeMenuDayRow(ymd: string, locale: string, t: TimeMenuTranslateFn): string {
  const dd = ymd.slice(8, 10);
  const dayNum = Number(dd);

  if (locale === "zh" || locale === "zhtw") {
    return t("gallery.timeScopeDayWithUnit", { dd });
  }
  if (locale === "ja") {
    return t("gallery.timeScopeDayWithUnitJa", { n: dayNum });
  }
  if (locale === "ko") {
    return t("gallery.timeScopeDayWithUnitKo", { n: dayNum });
  }
  return englishOrdinalDay(dayNum);
}

export function formatTimeFilterDetail(segment: string, locale: string, t: TimeMenuTranslateFn): string {
  const parts = segment.trim().split("-");
  const year = parts[0] ?? "";
  if (!/^\d{4}$/.test(year)) return segment;

  const labels = buildTimeMenuScopeLabels(t, locale);
  const month = parts[1] ?? "";
  if (!month) return labels.labelFullYearRow(year);

  const yearMonth = `${year}-${month}`;
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return segment;
  const monthLabel = labels.labelMonthRow(yearMonth);

  const day = parts[2] ?? "";
  if (!day) return `${year} ${monthLabel}`;

  const ymd = `${yearMonth}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return segment;
  return `${year} ${monthLabel} ${labels.labelDayRow(ymd)}`;
}
