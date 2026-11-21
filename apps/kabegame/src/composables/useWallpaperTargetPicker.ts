import { computed, shallowRef } from "vue";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "@/env";
import { messageBox } from "@/components/ui/messageBox";
import { kameMessage } from "@/utils/kameMessage";
import { useSettingsStore } from "@/stores/settings";
import { activeWallpaperTargets, wallpaperTargetScreenName } from "@/composables/useWallpaperTarget";
import { wallpaperScreensLoaded } from "@/composables/useWallpaperScreens";

/**
 * 目标选择弹窗的命令式入口（写法同 `useSettingChoice`）：模块级的待处理请求 + 挂在 `App.vue` 的宿主
 * `WallpaperTargetPickerHost`，调用方 `await` 结果。
 *
 * 设置页以外凡是要落到某个壁纸目标的操作（设为壁纸、设为轮播、用当前视图轮播）都先经它。只有一个活跃目标
 * （各屏复制、跨屏拼接，或逐屏独立但只接一块屏）时不弹，所以单屏用户与不用逐屏独立的用户感觉不到它。
 *
 * 它同时是这些操作的前置关口：壁纸功能关着时先引导开启（见 `ensureWallpaperEnabled`），
 * 这样新增入口只要经过它就不会漏。
 */

export interface WallpaperTargetPickRequest {
  /** 弹窗标题里的动作：设为壁纸 / 设为轮播 */
  action: "setWallpaper" | "setRotation";
}

interface PendingPick {
  request: WallpaperTargetPickRequest;
  resolve: (targetId: string | null) => void;
}

const current = shallowRef<PendingPick | null>(null);

/** 当前待处理的请求；宿主据此开关弹窗。同一时间只有一个。 */
export const wallpaperTargetPickRequest = computed(() => current.value?.request ?? null);

/**
 * 壁纸功能关着时先引导开启，形式同「这张图需要窗口模式」的确认框：问一句、用户同意就开，而不是等后端
 * 的 `reject_if_wallpaper_disabled` 报一条「壁纸功能已关闭，请先在设置中重新开启」让用户自己去设置页找。
 *
 * 开启走设置状态机（`save` 会 await `set_wallpaper_enabled`，后端在那之后已经拉起壁纸后端、恢复了上次的
 * 壁纸），所以返回之后调用方照常设自己的壁纸即可，不会再撞上禁用检查。
 *
 * @returns 能不能继续。`false` = 用户不开，或开关正忙（调用方按「取消」处理）。
 */
async function ensureWallpaperEnabled(): Promise<boolean> {
  // Web 版没有壁纸后端：「设为壁纸」只是记应用背景，轮播类写入由 `writeTarget` 的 guardDesktopOnly 拦，
  // 这里不插手（`wallpaperEnabled` 在 web 上也不是用户能开的开关）。
  if (IS_WEB) return true;

  const settingsStore = useSettingsStore();
  // 只在明确读到「关」时拦；还没读到设置就放过去，由后端的禁用检查兜底，免得首屏把正常操作挡住。
  if (settingsStore.values.wallpaperEnabled !== false) return true;

  try {
    await messageBox.confirm(
      i18n.global.t("settings.wallpaperEnableConfirmMessage"),
      i18n.global.t("settings.wallpaperModeConfirmTitle"),
      {
        confirmButtonText: i18n.global.t("settings.wallpaperEnableConfirmOk"),
        cancelButtonText: i18n.global.t("common.cancel"),
        type: "warning",
      },
    );
  } catch {
    return false; // 用户取消：什么都不做
  }

  // 另一处正在写同一个键时 `save` 会拒绝（返回 false）；这时说明原因，让用户再点一次，
  // 而不是静默什么都不发生。
  if (!(await settingsStore.save("wallpaperEnabled", true))) {
    kameMessage.warning(i18n.global.t("settings.wallpaperEnableBusy"));
    return false;
  }
  return true;
}

/**
 * 让用户选一个壁纸目标。
 *
 * 壁纸功能关着时先引导开启，用户不开就按取消处理（返回 null）。
 *
 * @returns 目标 id；用户取消返回 null。只有一个活跃目标时不弹，直接返回它。
 *   活跃目标与后端布局是同一份规则（`useActiveWallpaperTargets`），返回的 id 可以直接当命令的 `target`。
 *
 * @example
 * ```ts
 * const target = await pickWallpaperTarget({ action: "setRotation" });
 * if (!target) return; // 用户取消：什么都不做
 * await setWallpaperRotationPath(path, target);
 * ```
 */
export async function pickWallpaperTarget(request: WallpaperTargetPickRequest): Promise<string | null> {
  // 壁纸功能关着时先问开不开：开了才有「设到哪块屏」可谈，顺序也和「需要窗口模式」的引导一致
  // （都在真正下命令之前）。
  if (!(await ensureWallpaperEnabled())) return null;
  // 在线屏还没读到时活跃目标会被算成只有 multiple，先等首次读取
  await wallpaperScreensLoaded();
  const targets = activeWallpaperTargets();
  if (targets.length <= 1) return targets[0] ?? null;
  // 同时只有一个：后来的顶掉前一个（前一个按取消处理）
  current.value?.resolve(null);
  return new Promise((resolve) => {
    current.value = { request, resolve };
  });
}

/** 宿主在用户确定 / 取消 / 关闭时调用；没有待处理的请求时什么都不做。 */
export function resolveWallpaperTargetPick(targetId: string | null) {
  const pending = current.value;
  if (!pending) return;
  current.value = null;
  pending.resolve(targetId);
}

/**
 * 成功提示里要不要带屏名：有多个活跃目标、且 `targetId` 是其中一块在线屏的目标时返回屏名，否则为 null
 * （只有一个目标时提示照旧，不带屏名）。
 */
export function pickedScreenName(targetId: string | null | undefined): string | null {
  if (!targetId || activeWallpaperTargets().length <= 1) return null;
  return wallpaperTargetScreenName(targetId);
}
