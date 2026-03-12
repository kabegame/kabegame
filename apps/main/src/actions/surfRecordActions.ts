import { Picture, Delete } from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { SurfRecord } from "@/stores/surf";

/**
 * Context for surf record context menu. Extends ActionContext<SurfRecord> for ActionRenderer.
 */
export type SurfRecordActionContext = ActionContext<SurfRecord>;

/**
 * Actions for surf record right-click menu (desktop ContextMenu / Android ActionSheet).
 */
export function createSurfRecordActions(): ActionItem<SurfRecord>[] {
  return [
    {
      key: "viewImages",
      label: "查看下载图片",
      icon: Picture,
      command: "viewImages",
      visible: () => true,
    },
    {
      key: "delete",
      label: "删除",
      icon: Delete,
      command: "delete",
      dividerBefore: true,
      visible: () => true,
    },
  ];
}
