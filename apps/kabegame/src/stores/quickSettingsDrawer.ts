import { defineStore } from "pinia";
import { ref } from "vue";
import { IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";

export type QuickSettingsPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "failedimages"
  | "pluginbrowser"
  | "settings"
  | "autoconfigs";

const QUICK_SETTINGS_TITLE_KEYS: Record<QuickSettingsPageId, string> = {
  gallery: "settings.quickDrawerTitleGallery",
  albumdetail: "settings.quickDrawerTitleAlbumDetail",
  albums: "settings.quickDrawerTitleAlbums",
  failedimages: "settings.quickDrawerTitleFailedImages",
  pluginbrowser: "settings.quickDrawerTitlePluginBrowser",
  settings: "settings.quickDrawerTitleSettings",
  autoconfigs: "settings.quickDrawerTitleAutoConfigs",
};

export function getQuickSettingsDrawerTitleKey(pageId: QuickSettingsPageId): string {
  return QUICK_SETTINGS_TITLE_KEYS[pageId] ?? "settings.quickDrawerTitleDefault";
}

const defaultPageId: QuickSettingsPageId = "gallery";

function currentUrl() {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

export const useQuickSettingsDrawerStore = defineStore("quickSettingsDrawer", () => {
  const isOpen = ref(false);
  const pageId = ref<QuickSettingsPageId>(defaultPageId);

  const open = (p: QuickSettingsPageId = defaultPageId) => {
    pageId.value = p;
    if (IS_WEB && !isOpen.value) {
      trackEvent("quick_settings_drawer_toggle", {
        action: "open",
        page_id: p,
        url: currentUrl(),
      });
    }
    isOpen.value = true;
  };

  const close = () => {
    if (IS_WEB && isOpen.value) {
      trackEvent("quick_settings_drawer_toggle", {
        action: "close",
        page_id: pageId.value,
        url: currentUrl(),
      });
    }
    isOpen.value = false;
  };

  return { isOpen, pageId, open, close };
});
