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
 * - 离线状态管理
 * - 手动重连功能
 */
export function useDaemonStatus() {
  const daemonReady = ref(false);
  const daemonOffline = ref(false);
  const isReconnecting = ref(false);
  let daemonLoading: any | null = null;
  let daemonLoadingTimer: number | null = null;
  let daemonReadyUnlisten: (() => void) | null = null;
  let daemonOfflineUnlisten: (() => void) | null = null;
  let timeoutTimer: number | null = null;

  const init = async () => {
    // 200ms 内完成就不显示，避免闪屏
    daemonLoadingTimer = window.setTimeout(() => {
      daemonLoading = ElLoading.service({
        fullscreen: true,
        text: "正在启动后台服务…",
      });
    }, 200);

    // 设置 10 秒超时
    timeoutTimer = window.setTimeout(() => {
      if (!daemonReady.value) {
        daemonOffline.value = true;
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
      console.log("监听 daemon-ready 事件", Date.now());

      daemonReadyUnlisten = await listen("daemon-ready", () => {
        console.log("Daemon 已就绪", Date.now());
        daemonReady.value = true;
        daemonOffline.value = false;
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

      // 监听 daemon 离线事件
      daemonOfflineUnlisten = await listen("daemon-offline", () => {
        console.log("Daemon 离线");
        daemonOffline.value = true;
        daemonReady.value = false;
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

      // 注册监听器后，主动检查一次 daemon 状态
      // 避免 daemon 已经运行但事件在监听器注册前发送的情况
      console.log("监听器注册完毕，主动检查 daemon 状态", Date.now());
      try {
        const statusResult = await invoke<{
          status: "connected" | "connecting" | "disconnected";
          info?: any;
          error?: string;
        }>("check_daemon_status");
        
        // 解析连接状态
        const connStatus = statusResult?.status || "disconnected";
        console.log("Daemon 连接状态（主动检查）", Date.now(), {
          status: connStatus,
          info: statusResult?.info,
          error: statusResult?.error,
        });
        
        // 根据连接状态设置 UI 状态
        if (connStatus === "connected") {
          // 连接成功，说明 daemon 已经可用
          daemonReady.value = true;
          daemonOffline.value = false;
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
        } else {
          // disconnected 或 connecting：保持现有"等待事件/10秒超时"的策略
          // 不立刻强制 offline，等待事件通知或超时
          console.log(
            `Daemon 连接状态: ${connStatus}，等待事件通知或超时`,
            Date.now()
          );
        }
      } catch (error) {
        // daemon 尚未就绪，等待事件通知
        console.log("Daemon 尚未就绪，等待启动事件", Date.now(), error);
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

  const reconnect = async (): Promise<string | null> => {
    if (isReconnecting.value) {
      return null;
    }

    isReconnecting.value = true;
    daemonOffline.value = false;

    // 显示加载态
    let reconnectLoading: any | null = null;
    const reconnectLoadingTimer = window.setTimeout(() => {
      reconnectLoading = ElLoading.service({
        fullscreen: true,
        text: "正在重连后台服务…",
      });
    }, 200);

    try {
      // 调用后端重连命令
      await invoke("reconnect_daemon");
      
      // 等待 daemon-ready 事件（最多 10 秒）
      return new Promise(async (resolve) => {
        let resolved = false;
        const timeout = window.setTimeout(() => {
          if (!resolved) {
            resolved = true;
            daemonOffline.value = true;
            if (reconnectLoadingTimer) {
              window.clearTimeout(reconnectLoadingTimer);
            }
            if (reconnectLoading) {
              reconnectLoading.close();
            }
            isReconnecting.value = false;
            resolve("重连超时（10 秒）");
          }
        }, 10000);

        // 监听 daemon-ready 事件
        const unlistenFn = await listen("daemon-ready", () => {
          if (!resolved) {
            resolved = true;
            window.clearTimeout(timeout);
            if (reconnectLoadingTimer) {
              window.clearTimeout(reconnectLoadingTimer);
            }
            if (reconnectLoading) {
              reconnectLoading.close();
            }
            daemonReady.value = true;
            daemonOffline.value = false;
            isReconnecting.value = false;
            unlistenFn();
            resolve(null);
          }
        });
      });
    } catch (error: any) {
      daemonOffline.value = true;
      if (reconnectLoadingTimer) {
        window.clearTimeout(reconnectLoadingTimer);
      }
      if (reconnectLoading) {
        reconnectLoading.close();
      }
      isReconnecting.value = false;
      return error?.message || "重连失败";
    }
  };

  const cleanup = () => {
    if (daemonReadyUnlisten) {
      daemonReadyUnlisten();
      daemonReadyUnlisten = null;
    }
    if (daemonOfflineUnlisten) {
      daemonOfflineUnlisten();
      daemonOfflineUnlisten = null;
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
    daemonOffline,
    isReconnecting,
    init,
    reconnect,
    cleanup,
  };
}
