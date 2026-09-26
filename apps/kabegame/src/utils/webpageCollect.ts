import { WEBPAGE_PLUGIN_ID } from "@kabegame/core/stores/plugins";

/** URL 校验失败原因，对应 i18n `gallery.webpageUrlError.<reason>` */
export type WebpageUrlError = "empty" | "invalid" | "scheme" | "credentials";

export type WebpageUrlResult = { ok: true; url: string } | { ok: false; error: WebpageUrlError };

/**
 * 网页收集入口 URL：去首尾空白后必须是绝对 http(s)，拒绝用户名 / 密码（与 Rust
 * `crawler::webpage::validate_url` 同规则；后端仍会再校验一次）。
 */
export function validateWebpageUrl(raw: string): WebpageUrlResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: "empty" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "scheme" };
  }
  if (!parsed.hostname) return { ok: false, error: "invalid" };
  if (parsed.username || parsed.password) return { ok: false, error: "credentials" };
  return { ok: true, url: value };
}

type TaskLike = {
  pluginId: string;
  status: string;
  userConfig?: Record<string, any> | null;
};

/**
 * 运行中的任务能否「打开 WebView」：普通插件看静态 `scriptType === "js"`；
 * 网页收集看本次任务的后端（`userConfig.backend === "webview"`）。
 */
export function canOpenTaskWebview(
  task: TaskLike,
  plugins: ReadonlyArray<{ id: string; scriptType?: string }>,
): boolean {
  if (task.status !== "running" && task.status !== "waiting_downloads") return false;
  if (task.pluginId === WEBPAGE_PLUGIN_ID) {
    return task.userConfig?.backend === "webview";
  }
  return plugins.find((plugin) => plugin.id === task.pluginId)?.scriptType === "js";
}
