import { Minus, SwitchButton } from "@element-plus/icons-vue";
import { invoke } from "@kabegame/core/api";
import { resolveSettingWithPrompt } from "@kabegame/core/composables/useSettingChoice";
import { IS_LINUX, IS_WINDOWS } from "@kabegame/core/env";
import { useI18n } from "@kabegame/i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { markRaw, onMounted, onUnmounted } from "vue";

export function useMainCloseGuard() {
  if (!(IS_WINDOWS || IS_LINUX)) return;

  const { t } = useI18n();
  let unlisten: UnlistenFn | null = null;

  onMounted(async () => {
    unlisten = await listen("main-close-requested", async () => {
      const action = await resolveSettingWithPrompt("closeAction", {
        title: t("common.chooseCloseAction"),
        options: [
          {
            id: "tray",
            title: t('common["close.tray.title"]'),
            desc: t('common["close.tray.desc"]'),
            icon: markRaw(Minus),
          },
          {
            id: "exit",
            title: t('common["close.exit.title"]'),
            desc: t('common["close.exit.desc"]'),
            icon: markRaw(SwitchButton),
          },
        ],
      });
      if (action === "tray") {
        await getCurrentWindow().hide();
        return;
      }
      if (action === "exit") {
        await invoke("exit_app");
      }
    });
  });

  onUnmounted(() => {
    unlisten?.();
  });
}
