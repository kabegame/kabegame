import { readonly, ref, type Ref } from "vue";
import { invoke, listen } from "@/api";
import { IS_ANDROID, IS_WEB } from "@/env";
import { logger } from "@/utils/logger";
import { WALLPAPER_SCREENS_CHANGE_EVENT } from "@/utils/wallpaperTargets";

/** 取不到刷新率时的上限（同后端的回落值） */
const FALLBACK_MAX_FPS = 60;

/**
 * 显示器的最高刷新率：WPE 帧率滑条的上限（同 WPE 设置界面的 `runtime.frequencymax`）。全应用一份，
 * 第一次用到时读 `get_display_max_refresh_rate`（所有显示器当前刷新率的最大值），之后显示器变化
 * （`wallpaper-screens-change`）时重读。Android / Web 没有这条命令，恒为 60；读取失败也按 60。
 */
const maxFps = ref(FALLBACK_MAX_FPS);
let started = false;
/** 只认最后一次读取的结果，免得先发的慢请求覆盖后发的 */
let serial = 0;

function refresh() {
  const request = ++serial;
  void invoke<number>("get_display_max_refresh_rate").then(
    (value) => {
      if (request !== serial) return;
      maxFps.value =
        typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : FALLBACK_MAX_FPS;
    },
    (error) => {
      if (request !== serial) return;
      logger.warn("读取显示器最高刷新率失败:", error);
      maxFps.value = FALLBACK_MAX_FPS;
    },
  );
}

/**
 * 帧率滑条的上限（显示器最高刷新率，取不到时 60）。
 *
 * @example
 * ```ts
 * const maxFps = useDisplayMaxFps();
 * const range = computed(() => ({ min: WPE_FPS_MIN, max: maxFps.value }));
 * ```
 */
export function useDisplayMaxFps(): Readonly<Ref<number>> {
  if (!started && !IS_ANDROID && !IS_WEB) {
    started = true;
    // 先登记监听再读：反过来的话，读完到登记好之间的变化会漏掉
    void Promise.resolve(listen(WALLPAPER_SCREENS_CHANGE_EVENT, () => refresh()))
      .catch((error) => {
        logger.warn("监听显示器变化失败:", error);
      })
      .then(() => refresh());
  }
  return readonly(maxFps);
}
