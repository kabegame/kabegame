import { invoke } from "@tauri-apps/api/core";
import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";

function isRequiresWindowModeError(error: unknown): boolean {
  const msg =
    typeof error === "string"
      ? error
      : (error as any)?.message || String(error);
  return msg.includes("REQUIRES_WINDOW_MODE");
}

function isRequiresPluginModeError(error: unknown): boolean {
  const msg =
    typeof error === "string"
      ? error
      : (error as any)?.message || String(error);
  return msg.includes("REQUIRES_PLUGIN_MODE");
}

async function ensureWindowModeByUserConfirm(): Promise<void> {
  await ElMessageBox.confirm(
    i18n.global.t("settings.wallpaperModeWindowConfirmMessage"),
    i18n.global.t("settings.wallpaperModeConfirmTitle"),
    {
      confirmButtonText: i18n.global.t("settings.wallpaperModeConfirmOk"),
      cancelButtonText: i18n.global.t("common.cancel"),
      type: "warning",
    },
  );

  await invoke("set_wallpaper_mode", { mode: "window" });
}

async function ensurePluginModeByUserConfirm(): Promise<void> {
  await ElMessageBox.confirm(
    i18n.global.t("settings.wallpaperModePluginConfirmMessage"),
    i18n.global.t("settings.wallpaperModeConfirmTitle"),
    {
      confirmButtonText: i18n.global.t("settings.wallpaperModeConfirmOk"),
      cancelButtonText: i18n.global.t("common.cancel"),
      type: "warning",
    },
  );

  await invoke("set_wallpaper_mode", { mode: "plasma-plugin" });
}

export async function setWallpaperByImageIdWithModeFallback(
  imageId: string,
): Promise<void> {
  try {
    await invoke("set_wallpaper_by_image_id", { imageId });
  } catch (error) {
    if (isRequiresPluginModeError(error)) {
      await ensurePluginModeByUserConfirm();
      await invoke("set_wallpaper_by_image_id", { imageId });
      return;
    }
    if (isRequiresWindowModeError(error)) {
      await ensureWindowModeByUserConfirm();
      await invoke("set_wallpaper_by_image_id", { imageId });
      return;
    }
    throw error;
  }
}

