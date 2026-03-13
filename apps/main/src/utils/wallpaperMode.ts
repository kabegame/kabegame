import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ElMessageBox } from "element-plus";

function isRequiresWindowModeError(error: unknown): boolean {
  const msg =
    typeof error === "string"
      ? error
      : (error as any)?.message || String(error);
  return msg.includes("REQUIRES_WINDOW_MODE");
}

async function waitWallpaperModeSwitchComplete(
  mode: string,
  timeoutMs = 30000,
): Promise<void> {
  await new Promise<void>(async (resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const unlisten = await listen<{
      success: boolean;
      mode: string;
      error?: string;
    }>("wallpaper-mode-switch-complete", (event) => {
      if (event.payload.mode !== mode) return;
      if (timeoutId) clearTimeout(timeoutId);
      unlisten();
      if (event.payload.success) {
        resolve();
      } else {
        reject(
          new Error(event.payload.error || "切换窗口模式失败"),
        );
      }
    });

    timeoutId = setTimeout(() => {
      unlisten();
      reject(new Error("切换窗口模式超时"));
    }, timeoutMs);
  });
}

async function ensureWindowModeByUserConfirm(): Promise<void> {
  await ElMessageBox.confirm(
    "该媒体需要窗口模式才能设置为壁纸。是否切换到窗口模式？",
    "提示",
    {
      confirmButtonText: "切换",
      cancelButtonText: "取消",
      type: "warning",
    },
  );

  await invoke("set_wallpaper_mode", { mode: "window" });
  await waitWallpaperModeSwitchComplete("window");
}

export async function setWallpaperByImageIdWithModeFallback(
  imageId: string,
): Promise<void> {
  try {
    await invoke("set_wallpaper_by_image_id", { imageId });
  } catch (error) {
    if (!isRequiresWindowModeError(error)) throw error;
    await ensureWindowModeByUserConfirm();
    await invoke("set_wallpaper_by_image_id", { imageId });
  }
}

