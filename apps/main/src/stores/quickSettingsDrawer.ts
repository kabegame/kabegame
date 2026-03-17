import { defineStore } from "pinia";
import { ref } from "vue";

export type QuickSettingsPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "pluginbrowser"
  | "settings";

const QUICK_SETTINGS_TITLE_KEYS: Record<QuickSettingsPageId, string> = {
  gallery: "settings.quickDrawerTitleGallery",
  albumdetail: "settings.quickDrawerTitleAlbumDetail",
  albums: "settings.quickDrawerTitleAlbums",
  pluginbrowser: "settings.quickDrawerTitlePluginBrowser",
  settings: "settings.quickDrawerTitleSettings",
};

export function getQuickSettingsDrawerTitleKey(pageId: QuickSettingsPageId): string {
  return QUICK_SETTINGS_TITLE_KEYS[pageId] ?? "settings.quickDrawerTitleDefault";
}

const defaultPageId: QuickSettingsPageId = "gallery";

export const useQuickSettingsDrawerStore = defineStore("quickSettingsDrawer", () => {
  const isOpen = ref(false);
  const pageId = ref<QuickSettingsPageId>(defaultPageId);

  const open = (p: QuickSettingsPageId = defaultPageId) => {
    pageId.value = p;
    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
  };

  return { isOpen, pageId, open, close };
});
