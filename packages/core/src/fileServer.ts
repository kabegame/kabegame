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
