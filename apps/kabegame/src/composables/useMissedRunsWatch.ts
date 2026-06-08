import { onUnmounted, ref } from "vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { useI18n } from "@kabegame/i18n";
import { IS_WEB, IS_ANDROID } from "@kabegame/core/env";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { kameMessage } from "@kabegame/core/utils/kameMessage";
import type { MissedRunItem } from "@kabegame/core/stores/crawler";
import { useCrawlerStore } from "@/stores/crawler";

// 看门狗轮询间隔（毫秒）。每分钟比对一次墙钟时间。
const WATCHDOG_INTERVAL_MS = 60_000;
// 实际间隔超出预期这么多即判定系统曾休眠/挂起（漏掉了若干次 tick）。
const SLEEP_DRIFT_THRESHOLD_MS = 60_000;
// 合并 watchdog / focus / visibility 的多次触发，避免重复弹窗。
const RECHECK_DEBOUNCE_MS = 500;

type RecheckReason = "startup" | "sleep" | "focus" | "visibility";

/**
 * 漏跑任务检测的统一入口：集中管理「启动检查 + 休眠/恢复后重新检查 + 弹窗状态 + 处理逻辑」。
 *
 * 背景：后端调度器在系统休眠期间会漏过计划时刻（tokio 计时器走单调时钟，不随系统休眠推进），
 * 并把这类「过期」配置交给前端的漏跑弹窗处理。但弹窗此前只在 App `onMounted` 跑一次，
 * 系统唤醒后窗口仍在运行、不会重新触发，于是必须手动重载窗口。此 composable 在唤醒后
 * 自动重新检查，无需重载。
 *
 * 检测手段（均汇入同一个去抖的 recheck）：
 *  1. 墙钟看门狗（主）：setInterval(60s)，若两次 tick 的真实间隔远大于预期即判定曾休眠，
 *     此时已知「确为休眠」→ 弹窗使用休眠文案，并请求用户注意（macOS dock 弹一下 / Windows 任务栏闪烁）。
 *  2. 焦点 / 可见性（兜底）：窗口重新获焦或页面重新可见时再查一次（无法区分普通切换，故不弹 dock）。
 */
export function useMissedRunsWatch() {
  const crawlerStore = useCrawlerStore();
  const { t } = useI18n();

  const missedRunItems = ref<MissedRunItem[]>([]);
  const missedRunsModal = useModal();
  // 本次漏跑是否在系统休眠期间发生（用于切换弹窗文案）。
  const wasSystemSleep = ref(false);

  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastTickAt = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason: RecheckReason | null = null;
  let checking = false;
  let configsReadyAwaited = false;
  let unlistenFocus: (() => void) | null = null;
  let onVisibility: (() => void) | null = null;

  async function performRecheck(reason: RecheckReason) {
    if (IS_WEB) return; // web：后端启动时自动补跑漏跑配置，前端不处理。
    if (checking) return;
    checking = true;
    try {
      if (!configsReadyAwaited) {
        await crawlerStore.runConfigsReady;
        configsReadyAwaited = true;
      }
      const items = await crawlerStore.getMissedRuns();
      if (!items.length) return;
      missedRunItems.value = items;
      wasSystemSleep.value = reason === "sleep";
      missedRunsModal.open();
      // 仅在「确认是系统休眠」时争取注意力；普通切换/启动不打扰。
      if (reason === "sleep" && !IS_ANDROID) {
        try {
          await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
        } catch (e) {
          console.warn("requestUserAttention 失败:", e);
        }
      }
    } catch (error) {
      console.warn("检查漏跑任务失败:", error);
    } finally {
      checking = false;
    }
  }

  function scheduleRecheck(reason: RecheckReason) {
    if (IS_WEB) return;
    // 休眠优先级最高：合并窗口内只要出现过 sleep，就以 sleep 为准（保留休眠文案与 dock 提示）。
    pendingReason = reason === "sleep" || pendingReason === "sleep" ? "sleep" : reason;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const r = pendingReason ?? reason;
      pendingReason = null;
      debounceTimer = null;
      void performRecheck(r);
    }, RECHECK_DEBOUNCE_MS);
  }

  function startWatchdog() {
    lastTickAt = Date.now();
    watchdogTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTickAt;
      lastTickAt = now;
      // 间隔显著超出预期 → 期间发生过系统休眠/挂起。
      if (gap > WATCHDOG_INTERVAL_MS + SLEEP_DRIFT_THRESHOLD_MS) {
        scheduleRecheck("sleep");
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  async function init() {
    if (IS_WEB) return;
    // 启动检查（替代原 App.vue 的 checkMissedRunsAtStartup）。
    await performRecheck("startup");
    startWatchdog();
    // 窗口重新获焦
    try {
      unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) scheduleRecheck("focus");
      });
    } catch (e) {
      console.warn("注册窗口焦点监听失败:", e);
    }
    // 页面重新可见
    onVisibility = () => {
      if (document.visibilityState === "visible") scheduleRecheck("visibility");
    };
    document.addEventListener("visibilitychange", onVisibility);
  }

  function cleanup() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (unlistenFocus) {
      unlistenFocus();
      unlistenFocus = null;
    }
    if (onVisibility) {
      document.removeEventListener("visibilitychange", onVisibility);
      onVisibility = null;
    }
  }

  async function handleRunMissedNow() {
    const ids = missedRunItems.value.map((item) => item.configId);
    if (!ids.length) {
      missedRunsModal.close();
      return;
    }
    await crawlerStore.runMissedConfigs(ids);
    missedRunsModal.close();
    missedRunItems.value = [];
    wasSystemSleep.value = false;
    kameMessage.success(t("autoConfig.missedRuns.runNowSuccess"));
  }

  async function handleDismissMissed() {
    const ids = missedRunItems.value.map((item) => item.configId);
    if (!ids.length) {
      missedRunsModal.close();
      return;
    }
    await crawlerStore.dismissMissedConfigs(ids);
    missedRunsModal.close();
    missedRunItems.value = [];
    wasSystemSleep.value = false;
    kameMessage.info(t("autoConfig.missedRuns.dismissed"));
  }

  onUnmounted(cleanup);

  return {
    missedRunItems,
    missedRunsModal,
    wasSystemSleep,
    handleRunMissedNow,
    handleDismissMissed,
    init,
    cleanup,
  };
}
