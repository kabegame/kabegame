import { computed } from "vue";
import type { Component } from "vue";
import { FolderOpened, Hide, Key } from "@kabegame/element-plus-icons";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "@kabegame/core/env";
import { usePageBridgeStore } from "@/stores/pageBridge";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { useApp } from "@/stores/app";
import OrganizeHeaderControl from "./comps/OrganizeHeaderControl.vue";
import HiddenCleanupControl from "./comps/HiddenCleanupControl.vue";
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
 * 刷新的入口在各页面 header 上，不进工具箱（pageBridge.refresh 只服务全局快捷键）。
 * ToggleShowHidden / ToggleShowAlbumImages 语义上仍是当前页面的动作，
 * 通过 pageBridge 桥接——当前页面没注册时退回全局 path-route store。
 */
export function useGlobalTools() {
  const pageBridge = usePageBridgeStore();
  const globalPathRoute = useGlobalPathRoute();
  const app = useApp();

  const groups = computed<GlobalToolGroup[]>(() => {
    const maintenance: GlobalToolItem[] = [
      {
        id: "organize",
        group: "maintenance",
        label: t("header.organize"),
        comp: OrganizeHeaderControl,
        kind: "action",
      },
      {
        id: "cleanHidden",
        group: "maintenance",
        label: t("header.cleanHidden"),
        comp: HiddenCleanupControl,
        kind: "action",
      },
    ];
    if (!IS_WEB) {
      maintenance.push({
        id: "checkUpdate",
        group: "maintenance",
        label: t("updater.checkUpdate"),
        comp: CheckUpdateControl,
        kind: "action",
      });
    }
    if (IS_WEB) {
      // web 才有只读/写权限之分；setSuper 会整页刷新（?super=1 是唯一真源）
      maintenance.push({
        id: "superMode",
        group: "maintenance",
        label: t("settings.superMode"),
        icon: Key,
        kind: "toggle",
        toggleGet: () => app.isSuper,
        toggleSet: (v) => {
          void app.setSuper(v);
        },
      });
    }

    const display: GlobalToolItem[] = [];
    // 常驻项：no-album 与 hide 同为所有 path-route store 共享的全局路由参数，页面
    // 注册了桥接就走桥接（画廊那份顺带把页码复位），否则直接读写全局 store。
    // 画册详情赦免该参数（ignoreNoAlbum），开关仍在但对该页不生效。
    const noAlbumBridge = pageBridge.toggleShowAlbumImages ?? {
      get: () => globalPathRoute.noAlbum,
      set: (v: boolean) => {
        globalPathRoute.noAlbum = v;
      },
    };
    display.push({
      id: "toggleShowAlbumImages",
      group: "display",
      // 文案恒为「不显示…」（开关打开即该状态生效），跟着状态在显示/隐藏之间翻转
      // 会让人分不清这行到底是在描述当前状态还是点下去的效果
      label: t("header.hideAlbumImages"),
      icon: FolderOpened,
      kind: "toggle",
      toggleGet: noAlbumBridge.get,
      toggleSet: noAlbumBridge.set,
    });
    const hiddenBridge = pageBridge.toggleShowHidden ?? {
      get: () => globalPathRoute.hide,
      set: (v: boolean) => {
        globalPathRoute.hide = v;
      },
    };
    display.push({
      id: "toggleShowHidden",
      group: "display",
      label: t("header.hideHidden"),
      icon: Hide,
      kind: "toggle",
      toggleGet: hiddenBridge.get,
      toggleSet: hiddenBridge.set,
    });

    return [
      { id: "maintenance" as const, title: t("header.toolboxMaintenance"), items: maintenance },
      { id: "display" as const, title: t("header.toolboxDisplay"), items: display },
    ].filter((g) => g.items.length > 0);
  });

  return { groups };
}
