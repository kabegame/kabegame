import { Compass, Link } from "@element-plus/icons-vue";
import { i18n } from "@kabegame/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { markRaw } from "vue";
import { resolveSettingWithPrompt } from "../composables/useSettingChoice";
import { IS_ANDROID, IS_WEB } from "../env";
import { useSurfStore } from "../stores/surf";

export async function openExternalLink(url: string): Promise<void> {
  if (IS_WEB) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  if (IS_ANDROID) {
    await openUrl(url);
    return;
  }

  const t = i18n.global.t;
  const mode = await resolveSettingWithPrompt("linkOpenMode", {
    title: t("common.chooseLinkOpenMode"),
    options: [
      {
        id: "surf",
        title: t('common["linkOpen.surf.title"]'),
        desc: t('common["linkOpen.surf.desc"]'),
        icon: markRaw(Compass),
      },
      {
        id: "browser",
        title: t('common["linkOpen.browser.title"]'),
        desc: t('common["linkOpen.browser.desc"]'),
        icon: markRaw(Link),
      },
    ],
  });
  if (!mode) return;
  if (mode === "surf") {
    await useSurfStore().startSession(url);
    return;
  }
  await openUrl(url);
}
