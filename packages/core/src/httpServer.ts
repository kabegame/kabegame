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

export function fileToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  if (IS_ANDROID) return "";
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/file?path=${encodeURIComponent(path)}`;
}

/** 缩略图 URL：走 /thumbnail，后端按 thumbnail_path 查表校验 */
export function thumbnailToUrl(thumbnailPath: string): string {
  const path = (thumbnailPath || "").trim();
  if (!path) return "";
  if (IS_ANDROID) return "";
  if (httpServerBaseUrl === null) return "";
  return `${httpServerBaseUrl}/thumbnail?path=${encodeURIComponent(path)}`;
}
