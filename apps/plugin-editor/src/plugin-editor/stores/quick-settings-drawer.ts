import { createQuickSettingsDrawerStore } from "@kabegame/core/stores/quick-settings-drawer";

export type QuickSettingsPageId = "plugin-editor";

export const useQuickSettingsDrawerStore =
  createQuickSettingsDrawerStore<QuickSettingsPageId>({
    storeId: "pluginEditorQuickSettingsDrawer",
    defaultPageId: "plugin-editor",
    getTitle: (pageId) => {
      switch (pageId) {
        case "plugin-editor":
          return "插件编辑器设置";
        default:
          return "设置";
      }
    },
  });
