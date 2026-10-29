import type { Plugin } from "@/stores/plugins";
import { invoke } from "../api";
import { IS_ANDROID, IS_WEB } from "../env";

// null = not yet initialized; "" = web same-origin; "http://..." = absolute base
let httpServerBaseUrl: string | null = null;

/** 桌面 CEF 直接以 `file://` 显示并读取图库媒体；Android / Web 仍走 HTTP。 */
const DESKTOP_FILE_MEDIA = !IS_WEB && !IS_ANDROID;

export async function initHttpServerBaseUrl() {
  if (httpServerBaseUrl !== null) return;
  if (DESKTOP_FILE_MEDIA) {
    httpServerBaseUrl = "";
    return;
  }
  if (IS_WEB) {
    const apiRoot = (import.meta.env.VITE_API_ROOT as string | undefined) ?? "/";
    httpServerBaseUrl = apiRoot.replace(/\/$/, "");
    return;
  }
  try {
    const base = await invoke<string>("get_http_server_base_url");
    httpServerBaseUrl = (base || "").trim();
  } catch {
    httpServerBaseUrl = "";
  }
}

/** 绝对 URL 透传：web 上下文里的原图、缩略图与兼容副本路径已被后端
 *  改写成 https://cdn... 直链（见 `src-tauri/kabegame/src/web/image_rewrite.rs`），
 *  直接交给 <img> 即可，不再经过本地 /file 代理。desktop / Android 仍是文件系统路径（或 content URI）。 */
function asAbsoluteUrlOrNull(p: string): string | null {
  return p.startsWith("http://") || p.startsWith("https://") ? p : null;
}

type LocalMediaEndpoint = "file" | "thumbnail" | "compatible";

/** 把绝对路径接到本地媒体端点后。`/` 保留为 URL 路径分隔符，其余字符逐段编码。 */
function localMediaUrl(endpoint: LocalMediaEndpoint, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${httpServerBaseUrl}/${endpoint}/${encoded.replace(/^\/+/, "")}`;
}

/** 本地 HTTP 媒体地址：空值返回空串，绝对 http(s) 透传，base 未初始化返回空串。 */
function localMediaHttpUrl(endpoint: LocalMediaEndpoint, rawPath: string): string {
  const path = (rawPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return localMediaUrl(endpoint, path);
}

/** 显示用媒体地址：桌面 CEF 直接 `file://`，Android / Web 走本地 HTTP；绝对 http(s) 透传。 */
function localMediaDisplayUrl(endpoint: LocalMediaEndpoint, rawPath: string): string {
  const path = (rawPath || "").trim();
  if (!path) return "";
  if (DESKTOP_FILE_MEDIA && !asAbsoluteUrlOrNull(path)) return pathToFileUrl(path);
  return localMediaHttpUrl(endpoint, path);
}

/**
 * 本地绝对路径 → `file://` URL：Windows 盘符与 UNC、POSIX 都处理；逐段编码、`/` 保留；已是 `file:` 原样返回。
 * Windows 扩展长度前缀 `\\?\`（含 `\\?\UNC\`）先去掉。POSIX 路径里的反斜杠是合法文件名字符，编码成 `%5C`。
 */
export function pathToFileUrl(localPath: string): string {
  const path = (localPath || "")
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  if (!path) return "";
  if (/^file:/i.test(path)) return path;
  const encode = (segments: string) => segments.split("/").map(encodeURIComponent).join("/");
  // UNC：\\server\share\x → file://server/share/x
  const unc = path.match(/^\\\\([^\\]+)\\(.*)$/);
  if (unc) return `file://${unc[1]}/${encode(unc[2].replace(/\\/g, "/"))}`;
  // 盘符：C:\a\b 或 C:/a/b → file:///C:/a/b
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const slashed = path.replace(/\\/g, "/");
    return `file:///${slashed[0]}:${encode(slashed.slice(2))}`;
  }
  // POSIX：/a/b → file:///a/b
  return `file://${path.startsWith("/") ? "" : "/"}${encode(path)}`;
}

/** 从 URL 或本地路径取得文件名；先解码，才能正确切开 wildcard URL 里的 Windows `%5C`。 */
export function fileNameFromUrlOrPath(source: string): string {
  const value = (source || "").trim();
  if (!value) return "";
  const withoutHash = value.split("#", 1)[0] || "";
  const withoutQuery = withoutHash.split("?", 1)[0] || "";
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    // 非法百分号保持原值。
  }
  return decoded.split(/[/\\]/).filter(Boolean).pop()?.trim() || "";
}

/** 原图显示 URL：桌面 CEF 为 `file://`，Android / Web 走 /file。桌面 `fetch(file:)` 可直接读字节。 */
export function fileToUrl(localPath: string): string {
  return localMediaDisplayUrl("file", localPath);
}

/** 缩略图显示 URL：桌面 CEF 为 `file://`，Android / Web 走 /thumbnail（后端按 thumbnail_path 查表校验） */
export function thumbnailToUrl(thumbnailPath: string): string {
  return localMediaDisplayUrl("thumbnail", thumbnailPath);
}

/** 兼容副本显示 URL：桌面 CEF 为 `file://`，Android / Web 走 /compatible（后端按 compatible_path 查表校验） */
export function compatibleToUrl(compatiblePath: string): string {
  return localMediaDisplayUrl("compatible", compatiblePath);
}

/** Android / Web 的插件 HTTP 文件地址；桌面请用 `pluginAssetUrl` 或 `fetchPluginBytes`。 */
export function pluginFileUrl(plugin: Pick<Plugin, "id" | "version" | "fileOrigin">, relPath: string): string {
  if (DESKTOP_FILE_MEDIA || httpServerBaseUrl === null) return "";
  const query = new URLSearchParams({ v: plugin.version });
  if (plugin.fileOrigin?.kind === "store") query.set("source", plugin.fileOrigin.sourceId);
  if (plugin.fileOrigin?.kind === "preview") query.set("preview", plugin.fileOrigin.token);
  return `${httpServerBaseUrl}/plugin_file/${encodeURIComponent(plugin.id)}/${relPath.split("/").map(encodeURIComponent).join("/")}?${query}`;
}
