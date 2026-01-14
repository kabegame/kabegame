import { createQuickSettingsDrawerStore } from "@kabegame/core/stores/quick-settings-drawer";
import type { HelpPageId } from "@/help/helpRegistry";

export const useHelpDrawerStore = createQuickSettingsDrawerStore<HelpPageId>({
  storeId: "helpDrawer",
  defaultPageId: "gallery",
  getTitle: (pageId) => {
    switch (pageId) {
      case "gallery":
        return "画廊帮助";
      case "albumdetail":
        return "画册帮助";
      case "albums":
        return "画册列表帮助";
      case "taskdetail":
        return "任务帮助";
      case "pluginbrowser":
        return "源管理帮助";
      case "settings":
        return "设置帮助";
      default:
        return "帮助";
    }
  },
  defaultTitle: "帮助",
});

