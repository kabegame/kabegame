import { Picture, Delete } from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { SurfRecord } from "@/stores/surf";
import { i18n } from "@/i18n";

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
      key: "delete",
      label: t("common.delete"),
      icon: Delete,
      command: "delete",
      dividerBefore: true,
      visible: () => true,
    },
  ];
}
