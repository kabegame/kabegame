import { createQuickSettingsDrawerStore } from "@kabegame/core/stores/quick-settings-drawer";

export type QuickSettingsPageId =
  | "gallery"
  | "albums"
  | "albumdetail"
  | "pluginbrowser"
  | "settings";

export const useQuickSettingsDrawerStore =
  createQuickSettingsDrawerStore<QuickSettingsPageId>({
    storeId: "quickSettingsDrawer",
    defaultPageId: "gallery",
    getTitle: (pageId) => {
      switch (pageId) {
        case "gallery":
          return "画廊设置";
        case "albumdetail":
          return "画册设置";
        case "albums":
          return "画册列表设置";
        case "pluginbrowser":
          return "源管理设置";
        case "settings":
          return "设置";
        default:
          return "设置";
      }
    },
  });
