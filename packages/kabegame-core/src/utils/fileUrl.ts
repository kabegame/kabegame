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
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/file?path=${encodeURIComponent(path)}`;
}

/** 下载 URL：走 /download，**路径直接接在端点后面**而不是放进 query。
 *
 *  这样文件名天然落在 URL 末段，文件管理器（KDE KIO / GNOME gvfs）拖入时能直接
 *  拿它命名。`/file?path=...` 的末段恒为 `file`，落地文件会没有扩展名且互相覆盖。
 *
 *  该端点只在桌面挂载：web 的 localPath 已是 CDN 直链，由 asAbsoluteUrlOrNull
 *  透传；debug web 下 localPath 仍是真实路径，此时退回 /file，避免打到不存在的路由。 */
export function downloadToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (IS_WEB) return fileToUrl(path);
  if (httpServerBaseUrl === null) return "";
  // 按段编码：`/` 保留作 URL 路径分隔符，其余（中日文、空格、`#`、`?`、以及
  // Windows 路径里的 `\`）逐段百分号编码，由后端通配路由解回原路径。
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${httpServerBaseUrl}/download/${encoded.replace(/^\/+/, "")}`;
}

/** 缩略图 URL：走 /thumbnail，后端按 thumbnail_path 查表校验 */
export function thumbnailToUrl(thumbnailPath: string): string {
  const path = (thumbnailPath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/thumbnail?path=${encodeURIComponent(path)}`;
}

/** 兼容副本 URL：走 /compatible，后端按 compatible_path 查表校验 */
export function compatibleToUrl(compatiblePath: string): string {
  const path = (compatiblePath || "").trim();
  if (!path) return "";
  const abs = asAbsoluteUrlOrNull(path);
  if (abs) return abs;
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/compatible?path=${encodeURIComponent(path)}`;
}
