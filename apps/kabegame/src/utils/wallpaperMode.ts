import { invoke } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { IS_LINUX, IS_WEB } from "@/env";
import { useSettingsStore } from "@/stores/settings";
import { useWallpaperScreens } from "@/composables/useWallpaperScreens";
import {
  TARGET_MULTIPLE,
  activeTargetIds,
  effectiveDisplayMode,
  emptyWallpaperTargetConfig,
} from "@/utils/wallpaperTargets";
import { messageBox } from "@/components/ui/messageBox";

function isRequiresWindowModeError(error: unknown): boolean {
  const msg = typeof error === "string" ? error : (error as any)?.message || String(error);
  return msg.includes("REQUIRES_WINDOW_MODE");
}

function isRequiresPluginModeError(error: unknown): boolean {
  const msg = typeof error === "string" ? error : (error as any)?.message || String(error);
  return msg.includes("REQUIRES_PLUGIN_MODE");
}

async function ensureWindowModeByUserConfirm(): Promise<void> {
  await messageBox.confirm(
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

/** `get_plugin_mode_readiness` 的返回值（后端 `gnome::extension::Readiness`）。 */
type PluginModeReadiness =
  | { status: "ready"; gnome: boolean }
  | { status: "gnomeShellUnsupported"; version: string; min: number; max: number }
  | { status: "gnomeExtensionMissing"; version: string };

/**
 * 切到插件模式之前的检查（Linux）。GNOME 会话要 Shell 版本在支持范围内、Kabegame 的 Shell 扩展在线：版本不支持时提示升级系统
 * （或等 Kabegame 更新）；扩展不在线时问用户要不要安装，装完提示注销重新登录，这次不切。
 *
 * @returns 可以切时返回 `{ gnome }`（确认文案据此选）；不能切时返回 null（原因已经告诉用户）。
 * @throws 读不到 Shell 版本等检查本身出错时抛后端的错误。
 */
export async function preparePluginMode(): Promise<{ gnome: boolean } | null> {
  if (!IS_LINUX) return { gnome: false };
  const t = i18n.global.t;
  const readiness = await invoke<PluginModeReadiness>("get_plugin_mode_readiness");
  if (readiness.status === "ready") return { gnome: readiness.gnome };

  const title = t("settings.gnomeExtensionTitle");
  if (readiness.status === "gnomeShellUnsupported") {
    const { version, min, max } = readiness;
    const tooNew = Number.parseInt(version, 10) > max;
    await messageBox.alert(
      t(tooNew ? "settings.gnomeShellTooNew" : "settings.gnomeShellTooOld", { version, min, max }),
      title,
      {
        type: "warning",
      },
    );
    return null;
  }

  try {
    await messageBox.confirm(t("settings.gnomeExtensionInstallConfirm"), title, {
      confirmButtonText: t("settings.gnomeExtensionInstallOk"),
      cancelButtonText: t("common.cancel"),
      type: "info",
    });
  } catch {
    return null;
  }
  try {
    const outcome = await invoke<{ userExtensionsDisabled: boolean }>("install_gnome_shell_extension");
    const lines = [t("settings.gnomeExtensionInstalled")];
    if (outcome.userExtensionsDisabled) lines.push(t("settings.gnomeExtensionsSwitchedOff"));
    await messageBox.alert(lines.join(" "), title, { type: "success" });
  } catch (error) {
    const reason = typeof error === "string" ? error : (error as any)?.message || String(error);
    await messageBox.alert(t("settings.gnomeExtensionInstallFailed", { reason }), title, { type: "error" });
  }
  return null;
}

/** 插件模式的确认文案：GNOME 下是 Shell 扩展把壁纸窗口放到桌面，Plasma 下是换系统的壁纸插件。 */
export function pluginModeConfirmMessage(gnome: boolean): string {
  return i18n.global.t(
    gnome ? "settings.wallpaperModePluginConfirmMessageGnome" : "settings.wallpaperModePluginConfirmMessage",
  );
}

async function ensurePluginModeByUserConfirm(): Promise<void> {
  const ready = await preparePluginMode();
  // 同用户在确认框里取消：调用方按取消处理
  if (!ready) throw "cancel";
  await messageBox.confirm(
    pluginModeConfirmMessage(ready.gnome),
    i18n.global.t("settings.wallpaperModeConfirmTitle"),
    {
      confirmButtonText: i18n.global.t("settings.wallpaperModeConfirmOk"),
      cancelButtonText: i18n.global.t("common.cancel"),
      type: "warning",
    },
  );

  await invoke("set_wallpaper_mode", { mode: "plasma-plugin" });
}

/**
 * 引导切了壁纸模式之后，先前选的目标还能不能用：切模式可能让显示器模式回落（新模式不支持逐屏独立时
 * 回落各屏复制），原来的 `screen:<id>` 就不在活跃集合里了，这时改用新的默认目标（返回 null）。
 *
 * 后端切模式时已把回落后的显示器模式写回设置，这里直接读它（本地 store 要等事件才更新），
 * 再用与后端同规则的 `activeTargetIds` 判断。
 */
async function targetAfterModeSwitch(target: string | null): Promise<string | null> {
  if (!target) return null;
  const displayMode = effectiveDisplayMode(await invoke<string>("get_wallpaper_display_mode"), []);
  const active = activeTargetIds(
    displayMode,
    useWallpaperScreens().value,
    useSettingsStore().values.wallpaperDefaultScreen,
  );
  return active.includes(target) ? target : null;
}

/**
 * 把图设为壁纸目标 `target` 的壁纸（为空 = 默认目标）；这张图需要别的壁纸模式（视频 / WPE 要窗口模式）时
 * 先请用户确认切换，再设一次。
 *
 * @returns 实际设到的目标 id；null 表示落到了默认目标（没指定，或切模式后原目标不再活跃）。
 * @throws 用户在确认框里取消时抛 `"cancel"` / `"close"`（`ElMessageBox` 的约定）。
 */
export async function setWallpaperByImageIdWithModeFallback(
  imageId: string,
  target: string | null = null,
): Promise<string | null> {
  const set = (targetId: string | null) =>
    invoke("set_wallpaper_by_image_id", targetId ? { imageId, target: targetId } : { imageId });
  try {
    await set(target);
    return target;
  } catch (error) {
    if (isRequiresPluginModeError(error)) await ensurePluginModeByUserConfirm();
    else if (isRequiresWindowModeError(error)) await ensureWindowModeByUserConfirm();
    else throw error;
    const retarget = await targetAfterModeSwitch(target);
    await set(retarget);
    return retarget;
  }
}

/**
 * Web 版没有壁纸后端：「设为壁纸」只是把图记成应用背景，存在本地 `wallpaperTargets` 的 `multiple` 目标上
 * （该键在 web 走 localStorage，见 settingsDescriptors）。
 */
async function saveWebBackgroundImage(imageId: string | null): Promise<void> {
  const settingsStore = useSettingsStore();
  const targets = settingsStore.values.wallpaperTargets ?? {};
  const multiple = { ...(targets[TARGET_MULTIPLE] ?? emptyWallpaperTargetConfig()), currentImageId: imageId };
  await settingsStore.save("wallpaperTargets", { ...targets, [TARGET_MULTIPLE]: multiple });
}

/**
 * 设为壁纸目标 `target` 的壁纸（为空 = 默认目标；Web 版没有目标，记成应用背景）。
 *
 * @returns 实际设到的目标 id，见 `setWallpaperByImageIdWithModeFallback`。
 */
export async function setWallpaperOrBackground(imageId: string, target: string | null = null): Promise<string | null> {
  if (IS_WEB) {
    await saveWebBackgroundImage(imageId);
    return null;
  }

  return setWallpaperByImageIdWithModeFallback(imageId, target);
}

/**
 * Web 版删图后清掉本地记的背景图。桌面 / Android 不经这里：后端删图时会清所有目标里指向它的当前壁纸，
 * 并发 `setting-change { wallpaperTargets }`。
 */
export async function clearWebBackgroundIfRemoved(imageIds: readonly string[]): Promise<void> {
  if (!IS_WEB) return;
  const current = useSettingsStore().values.wallpaperTargets?.[TARGET_MULTIPLE]?.currentImageId;
  if (current && imageIds.includes(current)) await saveWebBackgroundImage(null);
}
