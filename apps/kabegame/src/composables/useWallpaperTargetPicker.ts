import { computed, shallowRef } from "vue";
import { activeWallpaperTargets, wallpaperTargetScreenName } from "@/composables/useWallpaperTarget";
import { wallpaperScreensLoaded } from "@/composables/useWallpaperScreens";

/**
 * 目标选择弹窗的命令式入口（写法同 `useSettingChoice`）：模块级的待处理请求 + 挂在 `App.vue` 的宿主
 * `WallpaperTargetPickerHost`，调用方 `await` 结果。
 *
 * 设置页以外凡是要落到某个壁纸目标的操作（设为壁纸、设为轮播、用当前视图轮播）都先经它。只有一个活跃目标
 * （各屏复制、跨屏拼接，或逐屏独立但只接一块屏）时不弹，所以单屏用户与不用逐屏独立的用户感觉不到它。
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
 * 让用户选一个壁纸目标。
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
