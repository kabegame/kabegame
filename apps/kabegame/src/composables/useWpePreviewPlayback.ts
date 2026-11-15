import { computed, type ComputedRef, type Ref } from "vue";
import type { WallpaperPlayback } from "@/components/wallpaper/types";
import { wpeSceneSettingsOf } from "@/utils/wpeSettings";
import { useWpeFollowAvailable } from "./useWpeFollowAvailable";
import { useWpePreviewSettings } from "./useWpePreviewSettings";

/**
 * 图库里一张 WPE 网页 / 场景壁纸的播放参数（交给 `ImageContent` 的 `playback`）：取这张壁纸的「预览设置」（存在 metadata，
 * 与桌面的全局「壁纸设置」互不影响，预览右栏改动当场生效），场景设置按能否跟随 WPE 换算。图片 id 为空时是 Kabegame 默认值。
 * 预览弹窗与应用背景各用一份；同一张壁纸的读写由 `useWpePreviewSettings` 共用。
 */
export function useWpePreviewPlayback(imageId: Ref<string | null | undefined>): ComputedRef<WallpaperPlayback> {
  const { values } = useWpePreviewSettings(imageId);
  const followAvailable = useWpeFollowAvailable();
  return computed(() => ({
    volume: values.value.volume,
    sceneSettings: wpeSceneSettingsOf(values.value, followAvailable.value),
  }));
}
