import { onScopeDispose, watch, type Ref } from "vue";
import appLogoUrl from "@/assets/icon-small.png";
import type { ImageInfo } from "@/types/image";

/**
 * 预览期间把系统媒体会话设成当前预览项：标题取图片名称，封面取应用左上角图标。
 * Chromium 优先采用有播放器、且访问过 navigator.mediaSession 的 frame；否则退回最上层访问过的 frame。
 * 网页壁纸的声音来自 iframe，但垫片没有访问 mediaSession，因此视频与网页壁纸预览都使用这里的元数据。
 * 图标构建时内联成 data URL，dev 下是 http 地址，都符合 MediaImage 的 scheme 要求。
 * 关闭或卸载时只清自己设的元数据，避免干扰其它预览弹窗。
 */
export function usePreviewMediaSession(image: Ref<ImageInfo | null>, active: Ref<boolean>) {
  const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
  if (!session || typeof MediaMetadata !== "function") return;
  let own: MediaMetadata | null = null;
  const clear = () => {
    if (own && session.metadata === own) session.metadata = null;
    own = null;
  };
  watch(
    () => (active.value && image.value ? image.value.displayName?.trim() || "Kabegame" : null),
    (title) => {
      if (title === null) return clear();
      own = new MediaMetadata({
        title,
        artwork: [{ src: appLogoUrl, sizes: "128x128", type: "image/png" }],
      });
      session.metadata = own;
    },
    { immediate: true },
  );
  onScopeDispose(clear);
}
