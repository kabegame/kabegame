import { readonly, ref, type DeepReadonly, type Ref } from "vue";
import { invoke, listen } from "@/api/rpc";
import { IS_WEB } from "@/env";
import { logger } from "@/utils/logger";
import { WALLPAPER_SCREENS_CHANGE_EVENT, type WallpaperScreen } from "@/utils/wallpaperTargets";

/**
 * 在线显示器列表，全应用一份。
 *
 * 首次使用时先登记 `wallpaper-screens-change` 再读一次 `list_wallpaper_screens`，之后只跟事件走
 * （事件带变化后的完整列表，不再回读）。活跃目标的计算（`useWallpaperTarget`）与显示器布局图
 * （`WallpaperScreenLayout`）读的是同一个 ref，不会各算各的。
 *
 * 没有屏幕枚举的平台（Android、目前的 Windows / Linux）与 Web 版恒为空。
 */
const screens = ref<WallpaperScreen[]>([]);
let started = false;
/** 收到过事件之后，首次读取的结果就过时了，不能再覆盖上去 */
let eventSeen = false;
/** 首次读取（成功或失败）结束后兑现 */
let loaded: Promise<void> = Promise.resolve();

function start() {
  // Web 版没有壁纸后端，也没有这条命令
  if (IS_WEB || started) return;
  started = true;
  // 先登记监听再读：反过来的话，读完到登记好之间的变化会漏掉
  loaded = Promise.resolve(
    listen<{ screens?: WallpaperScreen[] }>(WALLPAPER_SCREENS_CHANGE_EVENT, (event) => {
      const list = event.payload?.screens;
      if (!Array.isArray(list)) return;
      eventSeen = true;
      screens.value = list;
    }),
  )
    .catch((error) => {
      logger.warn("监听显示器变化失败:", error);
    })
    .then(() => invoke<WallpaperScreen[]>("list_wallpaper_screens"))
    .then((list) => {
      if (!eventSeen) screens.value = Array.isArray(list) ? list : [];
    })
    .catch((error) => {
      logger.warn("读取显示器列表失败:", error);
    });
}

/**
 * 在线显示器（主屏在前），随热插拔、排布与分辨率变化更新。
 *
 * @example
 * ```ts
 * const screens = useWallpaperScreens();
 * const hasSecondScreen = computed(() => screens.value.length > 1);
 * ```
 */
export function useWallpaperScreens(): DeepReadonly<Ref<WallpaperScreen[]>> {
  start();
  return readonly(screens);
}

/**
 * 等在线屏首次读到（读取失败也算结束，此时列表为空）。之后的调用立即兑现。
 *
 * 要按在线屏做一次性判断的地方（目标选择弹窗「只有一个活跃目标就不弹」）先等它，免得在首次读取返回前
 * 把「还没读到」当成「没有屏」。
 */
export function wallpaperScreensLoaded(): Promise<void> {
  start();
  return loaded;
}
