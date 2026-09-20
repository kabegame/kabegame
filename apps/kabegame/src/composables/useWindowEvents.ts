import { onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { IS_WEB } from "@kabegame/core/env";
import { invoke } from "@/api/rpc";
/**
 * 窗口事件监听 composable
 */
export function useWindowEvents() {
  let minimizeUnlisten: (() => void) | null = null;

  const init = async () => {
    if (IS_WEB) return;
    // 关闭主窗口 = 隐藏保活在托盘，整条路径在 Rust 侧（lib.rs 的 CloseRequested
    // handler → commands::window::hide_main_window），前端不参与，也不再询问用户。

    // 监听窗口最小化事件 - 修复壁纸窗口 Z-order（防止覆盖桌面图标）
    try {
      if (__WINDOWS__) {
        const currentWindow = getCurrentWebviewWindow();
        minimizeUnlisten = await currentWindow.listen("tauri://window-minimized", async () => {
          // 窗口最小化时，修复壁纸窗口 Z-order
          try {
            await invoke("fix_wallpaper_zorder");
          } catch (error) {
            // 忽略错误（非 Windows 或壁纸窗口不存在时）
          }
        });
      }
    } catch (error) {
      console.error("注册窗口最小化事件监听失败:", error);
    }
  };

  const cleanup = () => {
    if (minimizeUnlisten) {
      minimizeUnlisten();
      minimizeUnlisten = null;
    }
  };

  onUnmounted(() => {
    cleanup();
  });

  return {
    init,
    cleanup,
  };
}
