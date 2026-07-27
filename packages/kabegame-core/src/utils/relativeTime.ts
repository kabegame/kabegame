import { i18n } from "@kabegame/i18n";

/**
 * GitHub 风格的相对时间显示。
 *
 * 列表里只给「多久以前」这种一眼可比的粗粒度描述，具体到秒的时间放详情页看。
 * 不足一分钟算「刚刚」，之后依次按 分 / 时 / 天 / 周 / 月 / 年 进位。
 * 月和年按 30 天 / 365 天近似（GitHub 也是这么近似的）——这里的用途是「一眼看个
 * 大概」，不是历法计算，不必去算实际月份天数和闰年。
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function toMillis(value: number | Date) {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * 复数由各 locale 的 `a | b` 形式决定（中日韩只有一条分支，英文两条）。
 * key 不能带 `.`——vue-i18n 会把它当路径解析，扁平点号 key 得写成
 * `t('common["a.b"]')` 才认（见 openExternalLink.ts），这里统一用无点命名。
 */
function ago(
  unit: "Minutes" | "Hours" | "Days" | "Weeks" | "Months" | "Years",
  n: number,
) {
  return i18n.global.t(`common.time${unit}Ago`, { n }, n);
}

/**
 * 绝对时间，精确到秒——详情、tooltip 等「要看准确值」的位置用它。
 * @param ms 毫秒时间戳（后端秒级时间戳请先 `* 1000`）
 */
export function formatAbsoluteTime(ms: number | Date): string {
  return new Date(toMillis(ms)).toLocaleString();
}

/**
 * 相对时间，形如「刚刚」「3 分钟前」「2 周前」「5 个月前」「1 年前」。
 * @param ms  毫秒时间戳（后端秒级时间戳请先 `* 1000`）
 * @param now 参考时刻，默认当前时间；仅测试用
 */
export function formatRelativeTime(ms: number | Date, now = Date.now()): string {
  const target = toMillis(ms);
  const diff = Math.floor((now - target) / 1000);

  // 客户端时钟慢于写入时刻时 diff 为负，按「刚刚」处理，别显示 “-3 分钟前”
  if (diff < MINUTE) return i18n.global.t("common.timeJustNow");
  if (diff < HOUR) return ago("Minutes", Math.floor(diff / MINUTE));
  if (diff < DAY) return ago("Hours", Math.floor(diff / HOUR));
  if (diff < WEEK) return ago("Days", Math.floor(diff / DAY));
  if (diff < MONTH) return ago("Weeks", Math.floor(diff / WEEK));
  if (diff < YEAR) return ago("Months", Math.floor(diff / MONTH));
  return ago("Years", Math.floor(diff / YEAR));
}
