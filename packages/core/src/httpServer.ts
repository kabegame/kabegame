import { invoke } from "./api";
import { IS_ANDROID, IS_WEB } from "./env";

// null = not yet initialized; "" = web same-origin; "http://..." = absolute base
let httpServerBaseUrl: string | null = null;

export async function initHttpServerBaseUrl() {
  if (IS_ANDROID) return;
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

/** 绝对 URL 透传：web 上下文里 ImageInfo.localPath / thumbnailPath 已被后端
 *  改写成 https://cdn... 直链（见 `src-tauri/kabegame/src/web/image_rewrite.rs`），
 *  直接交给 <img> 即可，不再经过本地 /file 代理。desktop 仍是文件系统路径，走老路径。 */
function asAbsoluteUrlOrNull(p: string): string | null {
  return p.startsWith("http://") || p.startsWith("https://") ? p : null;
}

export function fileToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (IS_ANDROID) return "";
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/file?path=${encodeURIComponent(path)}`;
}

/** 缩略图 URL：走 /thumbnail，后端按 thumbnail_path 查表校验 */
export function thumbnailToUrl(thumbnailPath: string): string {
  const path = (thumbnailPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (IS_ANDROID) return "";
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/thumbnail?path=${encodeURIComponent(path)}`;
}
