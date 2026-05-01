import { invoke } from "@/api/rpc";
import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "@kabegame/core/env";
import { useSettingsStore } from "@kabegame/core/stores/settings";

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

export async function setWallpaperOrBackground(imageId: string): Promise<void> {
  console.log("[AppBackground] setWallpaperOrBackground", { imageId, isWeb: IS_WEB });
  if (IS_WEB) {
    await useSettingsStore().save("currentWallpaperImageId", imageId);
    console.log("[AppBackground] saved currentWallpaperImageId to local settings", { imageId });
    return;
  }

  await setWallpaperByImageIdWithModeFallback(imageId);
  console.log("[AppBackground] desktop wallpaper command completed", { imageId });
}
