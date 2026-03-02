import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID } from "@kabegame/core/env";
import { openImage } from "tauri-plugin-picker-api";

/**
 * 用系统默认方式打开本地图片（路径或 content:// URI）。
 * - Android：使用 picker 的 openImage(uri)，传入 content:// 或 file:// URI。
 * - 桌面：使用 open_file_path。
 */
export async function openLocalImage(localPath: string): Promise<void> {
  if (!localPath?.trim()) return;
  if (IS_ANDROID) {
    const uri = localPath.startsWith("content://")
      ? localPath
      : localPath.startsWith("/")
        ? `file://${localPath}`
        : `file:///${localPath}`;
    await openImage(uri);
  } else {
    await invoke("open_file_path", { filePath: localPath });
  }
}
