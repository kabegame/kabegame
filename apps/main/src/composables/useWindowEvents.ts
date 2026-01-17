import { onUnmounted } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";

/**
 * 窗口事件监听 composable
 */
export function useWindowEvents() {
  let minimizeUnlisten: (() => void) | null = null;

  const init = async () => {
    // 监听窗口关闭事件 - 隐藏而不是退出
    try {
      const currentWindow = getCurrentWebviewWindow();
      await currentWindow.onCloseRequested(async (event) => {
        // 阻止默认关闭行为
        event.preventDefault();
        // 调用后端命令隐藏窗口
        try {
          await invoke("hide_main_window");
        } catch (error) {
          console.error("隐藏窗口失败:", error);
        }
      });
    } catch (error) {
      console.error("注册窗口关闭事件监听失败:", error);
    }

    // 监听窗口最小化事件 - 修复壁纸窗口 Z-order（防止覆盖桌面图标）
    try {
      const currentWindow = getCurrentWebviewWindow();
      minimizeUnlisten = await currentWindow.listen("tauri://window-minimized", async () => {
        // 窗口最小化时，修复壁纸窗口 Z-order
        try {
          await invoke("fix_wallpaper_zorder");
        } catch (error) {
          // 忽略错误（非 Windows 或壁纸窗口不存在时）
        }
      });
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
