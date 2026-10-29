import type { Plugin } from "@/stores/plugins";
import { invoke } from "../api";
import { IS_WEB } from "../env";

// null = not yet initialized; "" = web same-origin; "http://..." = absolute base
let httpServerBaseUrl: string | null = null;

export async function initHttpServerBaseUrl() {
  if (httpServerBaseUrl !== null) return;
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
 *  直接交给 <img> 即可，不再经过本地 /file 代理。desktop 仍是文件系统路径，走老路径。 */
function asAbsoluteUrlOrNull(p: string): string | null {
  return p.startsWith("http://") || p.startsWith("https://") ? p : null;
}

/** 把绝对路径接到本地媒体端点后。`/` 保留为 URL 路径分隔符，其余字符逐段编码。 */
function localMediaUrl(endpoint: "file" | "thumbnail" | "compatible", path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${httpServerBaseUrl}/${endpoint}/${encoded.replace(/^\/+/, "")}`;
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

export function fileToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return localMediaUrl("file", path);
}

/** 缩略图 URL：走 /thumbnail，后端按 thumbnail_path 查表校验 */
export function thumbnailToUrl(thumbnailPath: string): string {
  const path = (thumbnailPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return localMediaUrl("thumbnail", path);
}

/** 兼容副本 URL：走 /compatible，后端按 compatible_path 查表校验 */
export function compatibleToUrl(compatiblePath: string): string {
  const path = (compatiblePath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return localMediaUrl("compatible", path);
}

/** 所有平台共享插件文件 host；清单路径逐段编码，来源与版本进入缓存键。 */
export function pluginFileUrl(plugin: Pick<Plugin, "id" | "version" | "fileOrigin">, relPath: string): string {
  if (httpServerBaseUrl === null) return "";
  const query = new URLSearchParams({ v: plugin.version });
  if (plugin.fileOrigin?.kind === "store") query.set("source", plugin.fileOrigin.sourceId);
  if (plugin.fileOrigin?.kind === "preview") query.set("preview", plugin.fileOrigin.token);
  return `${httpServerBaseUrl}/plugin_file/${encodeURIComponent(plugin.id)}/${relPath.split("/").map(encodeURIComponent).join("/")}?${query}`;
}
