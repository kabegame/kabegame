import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "./env";

let fileServerBaseUrl = "";

export async function initFileServerBaseUrl() {
  if (IS_ANDROID) return;
  if (fileServerBaseUrl) return;
  try {
    const base = await invoke<string>("get_file_server_base_url");
    fileServerBaseUrl = (base || "").trim();
  } catch {
    fileServerBaseUrl = "";
  }
}

export function fileToUrl(localPath: string): string {
  const path = (localPath || "").trim();
  if (!path) return "";
  if (IS_ANDROID) return "";
  if (!fileServerBaseUrl) return "";
  return `${fileServerBaseUrl}/file?path=${encodeURIComponent(path)}`;
}

/** 缩略图 URL：走 /thumbnail，后端按 thumbnail_path 查表校验 */
export function thumbnailToUrl(thumbnailPath: string): string {
  const path = (thumbnailPath || "").trim();
  if (!path) return "";
  if (IS_ANDROID) return "";
  if (!fileServerBaseUrl) return "";
  return `${fileServerBaseUrl}/thumbnail?path=${encodeURIComponent(path)}`;
}
