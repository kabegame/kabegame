import { defineStore } from "pinia";
import { ref } from "vue";
import { ElMessageBox } from "element-plus";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "@kabegame/core/env";
import {
  checkBatteryOptimizationStatus,
  requestBatteryOptimizationExemption,
} from "tauri-plugin-android-battery-optimization-api";

export const useBatteryOptimizationStore = defineStore("batteryOptimization", () => {
  const { t } = useI18n();
  /** true = 系统仍对应用施加省电优化（对后台任务不利） */
  const isOptimized = ref(false);
  /** 本会话内已自动弹出过一次说明（含确认或取消），避免反复打扰 */
  const hasShownAutoPromptThisSession = ref(false);

  async function checkStatus() {
    if (!IS_ANDROID) return;
    try {
      const status = await checkBatteryOptimizationStatus();
      isOptimized.value = status.isOptimized;
    } catch (e) {
      console.debug("checkBatteryOptimizationStatus:", e);
    }
  }

  async function checkAndPromptIfNeeded(options?: { force?: boolean }) {
    if (!IS_ANDROID) return;
    await checkStatus();
    if (!isOptimized.value) return;
    if (!options?.force && hasShownAutoPromptThisSession.value) return;
    try {
      await ElMessageBox.confirm(
        t("common.batteryOptimizationDesc"),
        t("common.batteryOptimizationTitle"),
        {
          confirmButtonText: t("common.batteryOptimizationConfirm"),
          cancelButtonText: t("common.batteryOptimizationCancel"),
          type: "warning",
        },
      );
      hasShownAutoPromptThisSession.value = true;
      await requestBatteryOptimizationExemption();
      window.setTimeout(() => {
        void checkStatus();
      }, 1500);
    } catch {
      hasShownAutoPromptThisSession.value = true;
    }
  }

  return { isOptimized, checkStatus, checkAndPromptIfNeeded };
});
