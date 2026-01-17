import { ref, onUnmounted } from "vue";
import { ElMessage, ElLoading } from "element-plus";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Daemon 状态管理 composable
 * 
 * 支持：
 * - 监听 daemon 启动事件
 * - 10 秒超时检测
 * - 错误处理和显示
 */
export function useDaemonStatus() {
  const daemonReady = ref(false);
  const daemonError = ref<{ error: string; daemon_path?: string } | null>(null);
  let daemonLoading: any | null = null;
  let daemonLoadingTimer: number | null = null;
  let daemonReadyUnlisten: (() => void) | null = null;
  let daemonFailedUnlisten: (() => void) | null = null;
  let timeoutTimer: number | null = null;

  const init = async () => {
    // 200ms 内完成就不显示，避免"闪一下"
    daemonLoadingTimer = window.setTimeout(() => {
      daemonLoading = ElLoading.service({
        fullscreen: true,
        text: "正在启动后台服务…",
      });
    }, 200);

    // 设置 10 秒超时
    timeoutTimer = window.setTimeout(() => {
      if (!daemonReady.value) {
        daemonError.value = {
          error: "核心启动失败，等待超时（10 秒）",
        };
        if (daemonLoadingTimer) {
          window.clearTimeout(daemonLoadingTimer);
          daemonLoadingTimer = null;
        }
        if (daemonLoading) {
          daemonLoading.close();
          daemonLoading = null;
        }
      }
    }, 10000);

    // 监听 daemon 就绪事件
    try {
      daemonReadyUnlisten = await listen("daemon-ready", () => {
        console.log("Daemon 已就绪");
        daemonReady.value = true;
        daemonError.value = null;
        if (daemonLoadingTimer) {
          window.clearTimeout(daemonLoadingTimer);
          daemonLoadingTimer = null;
        }
        if (timeoutTimer) {
          window.clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (daemonLoading) {
          daemonLoading.close();
          daemonLoading = null;
        }
      });

      // 监听 daemon 启动失败事件
      daemonFailedUnlisten = await listen<{ error: string; daemon_path?: string }>("daemon-startup-failed", (event) => {
        console.error("Daemon 启动失败:", event.payload);
        const errorMsg = event.payload?.error || "未知错误";
        const daemonPath = event.payload?.daemon_path;
        daemonError.value = {
          error: errorMsg,
          daemon_path: daemonPath,
        };
        if (daemonLoadingTimer) {
          window.clearTimeout(daemonLoadingTimer);
          daemonLoadingTimer = null;
        }
        if (timeoutTimer) {
          window.clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (daemonLoading) {
          daemonLoading.close();
          daemonLoading = null;
        }
        ElMessage.error(`后台服务启动失败：${errorMsg}`);
      });

      // 注册监听器后，主动检查一次 daemon 状态
      // 避免 daemon 已经运行但事件在监听器注册前发送的情况
      try {
        await invoke("check_daemon_status");
        // 如果检查成功，说明 daemon 已经可用
        console.log("Daemon 已就绪（主动检查）");
        daemonReady.value = true;
        daemonError.value = null;
        if (daemonLoadingTimer) {
          window.clearTimeout(daemonLoadingTimer);
          daemonLoadingTimer = null;
        }
        if (timeoutTimer) {
          window.clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (daemonLoading) {
          daemonLoading.close();
          daemonLoading = null;
        }
      } catch (error) {
        // daemon 尚未就绪，等待事件通知
        console.log("Daemon 尚未就绪，等待启动事件");
      }
    } catch (error) {
      console.error("注册 daemon 事件监听失败:", error);
      // 如果监听失败，清理加载状态
      if (daemonLoadingTimer) {
        window.clearTimeout(daemonLoadingTimer);
        daemonLoadingTimer = null;
      }
      if (timeoutTimer) {
        window.clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (daemonLoading) {
        daemonLoading.close();
        daemonLoading = null;
      }
    }
  };

  const cleanup = () => {
    if (daemonReadyUnlisten) {
      daemonReadyUnlisten();
      daemonReadyUnlisten = null;
    }
    if (daemonFailedUnlisten) {
      daemonFailedUnlisten();
      daemonFailedUnlisten = null;
    }
    if (daemonLoadingTimer) {
      window.clearTimeout(daemonLoadingTimer);
      daemonLoadingTimer = null;
    }
    if (timeoutTimer) {
      window.clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (daemonLoading) {
      daemonLoading.close();
      daemonLoading = null;
    }
  };

  onUnmounted(() => {
    cleanup();
  });

  return {
    daemonReady,
    daemonError,
    init,
    cleanup,
  };
}
