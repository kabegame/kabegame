import { defineStore } from "pinia";
import { ref } from "vue";
import type { HelpPageId } from "@/help/helpRegistry";

const HELP_DRAWER_TITLE_KEYS: Record<HelpPageId, string> = {
  gallery: "help.drawerTitleGallery",
  albumdetail: "help.drawerTitleAlbumDetail",
  albums: "help.drawerTitleAlbums",
  taskdetail: "help.drawerTitleTaskDetail",
  pluginbrowser: "help.drawerTitlePluginBrowser",
  settings: "help.drawerTitleSettings",
};

export function getHelpDrawerTitleKey(pageId: HelpPageId): string {
  return HELP_DRAWER_TITLE_KEYS[pageId] ?? "help.drawerTitleDefault";
}

const defaultPageId: HelpPageId = "gallery";

export const useHelpDrawerStore = defineStore("helpDrawer", () => {
  const isOpen = ref(false);
  const pageId = ref<HelpPageId>(defaultPageId);

  const open = (p: HelpPageId = defaultPageId) => {
    pageId.value = p;
    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
  };

  return { isOpen, pageId, open, close };
});
