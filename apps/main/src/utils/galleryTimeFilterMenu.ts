/**
 * 画廊「按时间」过滤：年 → 月 → 日嵌套菜单数据 + 单链父级折叠。
 */

export interface TimeMenuNode {
  /** 用于路径 `date/<name>` 的片段：`YYYY` | `YYYY-MM` | `YYYY-MM-DD` */
  name: string;
  /** 展示用（全年、全月、具体月/日等，短格式） */
  label: string;
  count: number;
  /**
   * 同列中唯一值（全年/全月 与路径 name 相同时区分，供 v-for / picker value）
   */
  key?: string;
  children?: TimeMenuNode[];
}

/** `@kabegame/i18n` / `useI18n().t`（仅用于时间菜单文案） */
export type TimeMenuTranslateFn = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** 构建树时注入「全年」「全月」及月/日展示格式（i18n） */
export interface TimeMenuScopeLabels {
  fullYear: string;
  fullMonth: string;
  /** 「2025 全年」等 */
  labelFullYearRow: (year: string) => string;
  labelMonthRow: (yearMonth: string) => string;
  labelDayRow: (ymd: string) => string;
}

/**
 * 与 `buildGalleryTimeMenuTree` 配套，在调用方传入 `t` 与当前 `locale`。
 */
export function buildTimeMenuScopeLabels(
  t: TimeMenuTranslateFn,
  locale: string
): TimeMenuScopeLabels {
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
export function formatTimeMenuMonthRow(
  yearMonth: string,
  locale: string,
  t: TimeMenuTranslateFn
): string {
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
export function formatTimeMenuDayRow(
  ymd: string,
  locale: string,
  t: TimeMenuTranslateFn
): string {
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

export interface DateGroupRow {
  year_month: string;
  count: number;
}

export interface DayGroupRow {
  ymd: string;
  count: number;
}

/** 与后端 `get_gallery_time_filter_data` / `GalleryTimeFilterPayload` 一致（camelCase） */
export interface GalleryTimeFilterPayload {
  months: DateGroupRow[];
  days: DayGroupRow[];
}

/** 月、日分组索引（与 `buildGalleryTimeMenuTree` 同源） */
export interface GalleryTimeIndex {
  daysByYm: Map<string, DayGroupRow[]>;
  yearToMonths: Map<string, DateGroupRow[]>;
  years: string[];
}

export function buildGalleryTimeIndex(
  monthGroups: DateGroupRow[],
  dayGroups: DayGroupRow[]
): GalleryTimeIndex {
  const daysByYm = new Map<string, DayGroupRow[]>();
  for (const d of dayGroups) {
    const ym = d.ymd.slice(0, 7);
    let arr = daysByYm.get(ym);
    if (!arr) {
      arr = [];
      daysByYm.set(ym, arr);
    }
    arr.push(d);
  }
  for (const arr of daysByYm.values()) {
    arr.sort((a, b) => a.ymd.localeCompare(b.ymd));
  }

  const yearToMonths = new Map<string, DateGroupRow[]>();
  for (const g of monthGroups) {
    const y = g.year_month.slice(0, 4);
    let arr = yearToMonths.get(y);
    if (!arr) {
      arr = [];
      yearToMonths.set(y, arr);
    }
    arr.push(g);
  }
  for (const arr of yearToMonths.values()) {
    arr.sort((a, b) => a.year_month.localeCompare(b.year_month));
  }

  const years = [...yearToMonths.keys()].sort((a, b) => a.localeCompare(b));
  return { daysByYm, yearToMonths, years };
}

/** 若某层仅有一个子级，则省略该层，直接展示子级（递归向下）。 */
export function collapseTimeMenuTree(nodes: TimeMenuNode[]): TimeMenuNode[] {
  let cur = nodes;
  while (cur.length === 1 && cur[0].children && cur[0].children.length > 0) {
    cur = cur[0].children;
  }
  return cur.map((n) => ({
    ...n,
    children: n.children ? collapseTimeMenuTree(n.children) : undefined,
  }));
}

export function buildGalleryTimeMenuTree(
  monthGroups: DateGroupRow[],
  dayGroups: DayGroupRow[],
  labels: TimeMenuScopeLabels
): TimeMenuNode[] {
  const { daysByYm, yearToMonths, years } = buildGalleryTimeIndex(
    monthGroups,
    dayGroups
  );

  const roots: TimeMenuNode[] = years.map((year) => {
    const months = yearToMonths.get(year) ?? [];
    const monthNodes: TimeMenuNode[] = months.map((m) => {
      const days = daysByYm.get(m.year_month) ?? [];
      const dayChildren: TimeMenuNode[] = days.map((d) => ({
        name: d.ymd,
        label: labels.labelDayRow(d.ymd),
        count: d.count,
      }));
      const fullMonth: TimeMenuNode = {
        name: m.year_month,
        label: labels.fullMonth,
        count: m.count,
        key: `${m.year_month}:full-month`,
      };
      const monthChildren: TimeMenuNode[] =
        dayChildren.length > 0 ? [fullMonth, ...dayChildren] : [fullMonth];
      return {
        name: m.year_month,
        label: labels.labelMonthRow(m.year_month),
        count: m.count,
        children: monthChildren,
      };
    });

    const total = months.reduce((s, m) => s + m.count, 0);
    const fullYear: TimeMenuNode = {
      name: year,
      label: labels.labelFullYearRow(year),
      count: total,
      key: `${year}:full-year`,
    };
    const yearChildren: TimeMenuNode[] =
      monthNodes.length > 0 ? [fullYear, ...monthNodes] : [fullYear];
    return {
      name: year,
      label: year,
      count: total,
      children: yearChildren,
    };
  });

  return collapseTimeMenuTree(roots);
}

export function isTimeMenuNodeActive(
  node: TimeMenuNode,
  dateTail: string | null
): boolean {
  if (!dateTail) return false;
  if (dateTail === node.name) return true;
  return dateTail.startsWith(`${node.name}-`);
}

/** 折叠后菜单最长路径深度（与桌面子菜单层级数一致） */
export function getTimeMenuMaxDepth(nodes: TimeMenuNode[]): number {
  if (!nodes.length) return 0;
  return (
    1 +
    Math.max(
      0,
      ...nodes.map((n) =>
        n.children?.length ? getTimeMenuMaxDepth(n.children) : 0
      )
    )
  );
}

// --- Android：列数 = `getTimeMenuMaxDepth(timeMenuRoots)`，与桌面折叠树一致 ---

export type AndroidTimePickerOption = { text: string; value: string };

/** 无下级时占位列 */
export const ANDROID_TIME_PLACEHOLDER = "__ANDROID_TIME_PLACEHOLDER__";

function pickFirstValue(col: AndroidTimePickerOption[], fallback: string): string {
  return col[0]?.value ?? fallback;
}

function clampValue(col: AndroidTimePickerOption[], v: string): string {
  if (col.some((o) => o.value === v)) return v;
  return pickFirstValue(col, v);
}

export function nodeId(n: TimeMenuNode): string {
  return n.key ?? n.name;
}

export function nodesToTimePickerOptions(nodes: TimeMenuNode[]): AndroidTimePickerOption[] {
  return nodes.map((n) => ({
    text: `${n.label} (${n.count})`,
    value: nodeId(n),
  }));
}

/**
 * 与 `syncTimeMenuPickerState` 一致：按当前选中值重算各列（联动）。
 */
export function syncTimeMenuPickerState(
  roots: TimeMenuNode[],
  rawValues: readonly string[]
): { columns: AndroidTimePickerOption[][]; values: string[] } {
  const maxD = getTimeMenuMaxDepth(roots);
  if (!maxD) return { columns: [], values: [] };
  const values: string[] = [];
  const columns: AndroidTimePickerOption[][] = [];
  let levelNodes = roots;
  for (let i = 0; i < maxD; i++) {
    if (!levelNodes.length) {
      columns.push([{ text: "\u2014", value: ANDROID_TIME_PLACEHOLDER }]);
      values.push(ANDROID_TIME_PLACEHOLDER);
      continue;
    }
    const col = nodesToTimePickerOptions(levelNodes);
    columns.push(col);
    const v = clampValue(col, rawValues[i] ?? "");
    values.push(v);
    const node = levelNodes.find((n) => nodeId(n) === v);
    levelNodes = node?.children ?? [];
  }
  return { columns, values };
}

export function todayYmdParts(d = new Date()): {
  y: string;
  ym: string;
  ymd: string;
} {
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { y, ym: `${y}-${m}`, ymd: `${y}-${m}-${day}` };
}

/** 在折叠树中找 `name === targetTail` 的最深路径（value 为 key ?? name） */
export function findBestPathMatchingTail(
  nodes: TimeMenuNode[],
  targetTail: string,
  path: string[] = []
): string[] | null {
  let best: string[] | null = null;
  for (const n of nodes) {
    const id = nodeId(n);
    const nextPath = [...path, id];
    if (n.name === targetTail) {
      if (!best || nextPath.length >= best.length) best = nextPath;
    }
    if (n.children?.length) {
      const sub = findBestPathMatchingTail(n.children, targetTail, nextPath);
      if (sub && (!best || sub.length > best.length)) best = sub;
    }
  }
  return best;
}

function firstLeafPath(nodes: TimeMenuNode[], path: string[] = []): string[] | null {
  if (!nodes.length) return null;
  const n = nodes[0]!;
  const id = nodeId(n);
  const next = [...path, id];
  if (!n.children?.length) return next;
  return firstLeafPath(n.children, next) ?? next;
}

/**
 * 打开 picker 时的初始路径：优先当前 `dateTail`，否则按「今年 / 本月 / 本日」在树中匹配。
 */
export function resolveInitialTimePickPath(
  roots: TimeMenuNode[],
  dateTail: string | null
): string[] {
  const maxD = getTimeMenuMaxDepth(roots);
  if (!maxD) return [];
  const o = todayYmdParts();
  const prefer =
    dateTail?.trim() ||
    (maxD >= 1 ? o.ymd : o.y);
  let path =
    findBestPathMatchingTail(roots, prefer) ??
    findBestPathMatchingTail(roots, o.ymd) ??
    findBestPathMatchingTail(roots, o.ym) ??
    findBestPathMatchingTail(roots, o.y);
  if (!path) {
    path = firstLeafPath(roots);
  }
  if (!path) return [];
  const synced = syncTimeMenuPickerState(roots, path);
  return synced.values;
}

/** 各列选中 value → `date/` 路径段（不含前缀） */
export function resolveTimeMenuPickToDateTail(
  roots: TimeMenuNode[],
  values: readonly string[]
): string {
  let nodes = roots;
  let lastName = "";
  const maxD = getTimeMenuMaxDepth(roots);
  for (let i = 0; i < maxD && i < values.length; i++) {
    const v = values[i];
    if (v === ANDROID_TIME_PLACEHOLDER) break;
    const node = nodes.find((n) => nodeId(n) === v);
    if (!node) break;
    lastName = node.name;
    nodes = node.children ?? [];
  }
  return lastName;
}
