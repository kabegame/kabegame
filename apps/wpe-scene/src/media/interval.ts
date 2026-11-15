/**
 * 刷新计时器的间隔（P11c，rea-p11-media 1.5）：WPE 主线程的定时器 `0x68` 是 `clamp(config["windowupdaterate"], 50, 5000)` 毫秒（本机 1000）。
 * 宿主读 WPE `config.json` 的 `general.user.windowupdaterate`，读不到（没有安装目录、没有这个键、不是数）用 1000。
 */
export const MEDIA_DEFAULT_INTERVAL_MS = 1000;
export const MEDIA_MIN_INTERVAL_MS = 50;
export const MEDIA_MAX_INTERVAL_MS = 5000;

/** `windowupdaterate` 的值 → 间隔（毫秒）；不是有限数时 `null`（调用方用缺省并记一条 debug）。 */
export function mediaIntervalOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MEDIA_MAX_INTERVAL_MS, Math.max(MEDIA_MIN_INTERVAL_MS, Math.trunc(value)));
}
