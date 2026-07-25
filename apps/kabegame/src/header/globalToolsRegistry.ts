import { computed } from "vue";
import type { Component } from "vue";
import { FolderOpened, Refresh, View } from "@element-plus/icons-vue";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "@kabegame/core/env";
import { usePageBridgeStore } from "@/stores/pageBridge";
import { shortcutLabel } from "@/composables/useGlobalShortcuts";
import OrganizeHeaderControl from "./comps/OrganizeHeaderControl.vue";
import CheckUpdateControl from "./comps/CheckUpdateControl.vue";

const t = (key: string) => i18n.global.t(key);

export type GlobalToolGroupId = "maintenance" | "display";

export interface GlobalToolItem {
  id: string;
  group: GlobalToolGroupId;
  label: string;
  icon?: Component;
  /** 自定义组件（如 OrganizeHeaderControl/CheckUpdateControl），优先于 action/toggle 渲染 */
  comp?: Component;
  shortcut?: string;
  kind: "action" | "toggle";
  action?: () => void;
  toggleGet?: () => boolean;
  toggleSet?: (value: boolean) => void;
}

export interface GlobalToolGroup {
  id: GlobalToolGroupId;
  title: string;
  items: GlobalToolItem[];
}

/**
 * 全局工具箱条目：维护类动作 + 显示类开关。
 * Refresh / ToggleShowHidden / ToggleShowAlbumImages 语义上仍是当前页面的动作，
 * 通过 pageBridge 桥接——当前页面没注册时该项不出现。
 */
export function useGlobalTools() {
  const pageBridge = usePageBridgeStore();

  const groups = computed<GlobalToolGroup[]>(() => {
    const maintenance: GlobalToolItem[] = [
      {
        id: "organize",
        group: "maintenance",
        label: t("header.organize"),
        comp: OrganizeHeaderControl,
        kind: "action",
      },
    ];
    if (pageBridge.refresh) {
      maintenance.push({
        id: "refresh",
        group: "maintenance",
        label: t("header.refresh"),
        icon: Refresh,
        shortcut: shortcutLabel("refresh"),
        kind: "action",
        action: () => pageBridge.refresh?.(),
      });
    }
    if (!IS_WEB) {
      maintenance.push({
        id: "checkUpdate",
        group: "maintenance",
        label: t("updater.checkUpdate"),
        comp: CheckUpdateControl,
        kind: "action",
      });
    }

    const display: GlobalToolItem[] = [];
    if (pageBridge.toggleShowAlbumImages) {
      const bridge = pageBridge.toggleShowAlbumImages;
      display.push({
        id: "toggleShowAlbumImages",
        group: "display",
        label: bridge.get() ? t("header.showAlbumImages") : t("header.hideAlbumImages"),
        icon: FolderOpened,
        kind: "toggle",
        toggleGet: bridge.get,
        toggleSet: bridge.set,
      });
    }
    if (pageBridge.toggleShowHidden) {
      const bridge = pageBridge.toggleShowHidden;
      display.push({
        id: "toggleShowHidden",
        group: "display",
        label: bridge.get() ? t("header.showHidden") : t("header.hideHidden"),
        icon: View,
        kind: "toggle",
        toggleGet: bridge.get,
        toggleSet: bridge.set,
      });
    }

    return [
      { id: "maintenance" as const, title: t("header.toolboxMaintenance"), items: maintenance },
      { id: "display" as const, title: t("header.toolboxDisplay"), items: display },
    ].filter((g) => g.items.length > 0);
  });

  return { groups };
}
