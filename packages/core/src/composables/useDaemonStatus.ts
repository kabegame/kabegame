import { ref, onMounted } from "vue";
import { listen } from "@tauri-apps/api/event";

/**
 * 后端状态管理 composable
 *
 * 在嵌入式模式下，后端会直接启动并发送 ready 事件。
 * 这个 composable 监听后端就绪事件并管理状态。
 */
export function useDaemonStatus() {
  const daemonReady = ref(false);
  const daemonOffline = ref(false);
  const isReconnecting = ref(false);
  const daemonError = ref<{ error: string; daemon_path: string } | null>(null);
  let daemonReadyUnlisten: (() => void) | null = null;

  const init = async () => {
    try {
      console.log("监听后端就绪事件", Date.now());

      // 监听后端就绪事件（兼容旧事件名）
      daemonReadyUnlisten = await listen("daemon-ready", () => {
        console.log("后端已就绪", Date.now());
        daemonReady.value = true;
        daemonOffline.value = false;
        daemonError.value = null;
      });

      // 立即标记为就绪，因为嵌入式后端会直接发送事件
      // 但为了兼容性，我们仍然监听事件
      daemonReady.value = true;
      daemonOffline.value = false;

    } catch (error) {
      console.error("注册后端事件监听失败:", error);
    }
  };

  const reconnect = async (): Promise<string | null> => {
    // 在嵌入式模式下，后端始终可用
    daemonReady.value = true;
    daemonOffline.value = false;
    daemonError.value = null;
    return null;
  };

  const cleanup = () => {
    if (daemonReadyUnlisten) {
      daemonReadyUnlisten();
      daemonReadyUnlisten = null;
    }
  };

  onMounted(() => {
    init();
  });

  return {
    daemonReady,
    daemonOffline,
    isReconnecting,
    daemonError,
    init,
    reconnect,
    cleanup,
  };
}
