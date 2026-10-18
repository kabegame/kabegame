import { Picture, Delete, InfoFilled, House } from "@kabegame/element-plus-icons";
import { IS_ANDROID } from "@/env";
import type { ActionItem, ActionContext } from "@/actions/types";
import type { SurfRecord } from "@/stores/surf";
import { i18n } from "@kabegame/i18n";

/**
 * Context for surf record context menu. Extends ActionContext<SurfRecord> for ActionRenderer.
 */
export type SurfRecordActionContext = ActionContext<SurfRecord>;

/**
 * Actions for surf record right-click menu (desktop ContextMenu / Android ActionSheet).
 */
export function createSurfRecordActions(): ActionItem<SurfRecord>[] {
  const t = (key: string) => i18n.global.t(key);
  return [
    {
      key: "viewImages",
      label: t("surf.viewDownloadedImages"),
      icon: Picture,
      command: "viewImages",
      visible: () => true,
    },
    {
      key: "details",
      label: t("surf.recordDetails"),
      icon: InfoFilled,
      command: "details",
      visible: () => true,
    },
    {
      key: "addToHome",
      label: t("surf.addToHome"),
      icon: House,
      command: "addToHome",
      // 桌面快捷方式只在 Android 上实现（ShortcutManager 固定到桌面）。
      visible: () => IS_ANDROID,
    },
    {
      key: "delete",
      label: t("common.delete"),
      icon: Delete,
      command: "delete",
      dividerBefore: true,
      visible: () => true,
    },
  ];
}
