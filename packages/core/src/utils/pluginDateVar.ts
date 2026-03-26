import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

/** 与 Element Plus date-picker、插件 config 约定一致 */
export const PLUGIN_DATE_PICKER_FORMAT = "YYYY-MM-DD";

/**
 * 解析 `dateMin` / `dateMax`：固定日 `YYYY-MM-DD`，或关键字 `today` / `yesterday`（不区分大小写）。
 * `refNow` 为判定「今天」的参考时刻（默认 `dayjs()`）；传入 VueUse `useNow` 的值可随时间推进。
 * 无法识别时返回 null（视为未设置边界）。
 */
export function parsePluginDateBound(
  raw: string,
  refNow: dayjs.ConfigType = dayjs()
): dayjs.Dayjs | null {
  const t = raw.trim();
  if (!t) return null;
  const low = t.toLowerCase();
  const todayStart = dayjs(refNow).startOf("day");
  if (low === "today") return todayStart;
  if (low === "yesterday") return todayStart.subtract(1, "day");
  const d = dayjs(t, PLUGIN_DATE_PICKER_FORMAT, true);
  return d.isValid() ? d.startOf("day") : null;
}

/**
 * 解析已保存的日期字符串（兼容 storageFormat / ISO / YYYYMMDD）。
 */
export function parsePluginDateStored(
  raw: string,
  storageFormat: string
): dayjs.Dayjs | null {
  const t = raw.trim();
  if (!t) return null;
  const primary =
    storageFormat.trim() !== "" ? storageFormat.trim() : PLUGIN_DATE_PICKER_FORMAT;
  const tryOrder = [primary, PLUGIN_DATE_PICKER_FORMAT, "YYYYMMDD"];
  const tried = new Set<string>();
  for (const fmt of tryOrder) {
    if (!fmt || tried.has(fmt)) continue;
    tried.add(fmt);
    const d = dayjs(t, fmt, true);
    if (d.isValid()) return d;
  }
  return null;
}

/**
 * 按插件 `format` 输出传给后端 / Rhai 的日期字符串。
 * 启动任务、保存运行配置前应调用，避免 UI 未触发 change 时仍为 YYYY-MM-DD。
 */
export function formatPluginDateForBackend(
  raw: string,
  storageFormat: string
): string {
  const t = raw.trim();
  if (!t) return "";
  const fmt =
    storageFormat.trim() !== "" ? storageFormat.trim() : PLUGIN_DATE_PICKER_FORMAT;
  const d = parsePluginDateStored(t, fmt);
  if (!d) return t;
  return d.format(fmt);
}

/** 在已解析的日历日上加减天数，按 storageFormat 输出；失败返回 null */
export function shiftPluginDateByDays(
  raw: string,
  storageFormat: string,
  deltaDays: number
): string | null {
  const fmt =
    storageFormat.trim() !== "" ? storageFormat.trim() : PLUGIN_DATE_PICKER_FORMAT;
  const d = parsePluginDateStored(raw.trim(), fmt);
  if (!d || deltaDays < 0) return null;
  return d.add(deltaDays, "day").format(fmt);
}
