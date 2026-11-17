import { onMounted, onUnmounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import { kameMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";

/** Rust `wpe_scene_report` 收到宿主的 unsupported 上报后发给主窗口的事件（活的场景图 L5 点 5） */
export type SceneUnsupportedPayload = {
  /** 场景的图片 id（宿主地址的 `kbScene`） */
  image: string;
  /** 上报的宿主在哪个窗口里：壁纸窗口为 `desktop`，主窗口（预览、应用背景）为 `preview` */
  surface: "desktop" | "preview";
  keys: string[];
};

/**
 * 场景壁纸运行中用到暂不支持的特性时，经看板娘提示用户（场景不退回，只是相关图层没画出）。
 *
 * 桌面壁纸窗口没有看板娘，Rust 把提示一律送到主窗口，所以只在 `App.vue` 挂一次。同一张图同一个键本次运行
 * 只提示一次：建删循环的场景会反复冒同一个键，宿主重新加载也会换实例重报。场景壁纸只在桌面端有，Web 与
 * Android 不监听。
 */
export function useSceneUnsupportedNotice() {
  const { t } = useI18n();
  /** 图片 id → 已提示过的键 */
  const notified = new Map<string, Set<string>>();
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  function onUnsupported({ image, surface, keys }: SceneUnsupportedPayload) {
    let seen = notified.get(image);
    if (!seen) notified.set(image, (seen = new Set()));
    const fresh: string[] = [];
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(key);
    }
    if (fresh.length === 0) return;
    const message = surface === "desktop" ? "gallery.wpeSceneUnsupportedDesktop" : "gallery.wpeSceneUnsupportedPreview";
    kameMessage.warning(t(message, { keys: fresh.join(", ") }));
  }

  onMounted(async () => {
    if (IS_WEB || IS_ANDROID) return;
    try {
      const stop = await listen<SceneUnsupportedPayload>("wpe-scene-unsupported", (event) => {
        if (!disposed) onUnsupported(event.payload);
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (error) {
      logger.warn(`监听场景运行中不支持项失败: ${error}`);
    }
  });

  onUnmounted(() => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  });
}
