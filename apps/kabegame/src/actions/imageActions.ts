import {
  InfoFilled,
  DocumentCopy,
  FolderOpened,
  Folder,
  Picture,
  Star,
  StarFilled,
  FolderAdd,
  Download,
  Delete,
  More,
  Share,
  Hide,
  View,
} from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { ImageInfo } from "@kabegame/core/types/image";
import { IS_WINDOWS, IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import { i18n } from "@kabegame/i18n";
import { useUiStore } from "@kabegame/core/stores/ui";

export interface CreateImageActionsOptions {
  /** Custom text for remove action (e.g., "删除" | "从画册移除") */
  removeText?: string;
  /** Keys to hide in single-select mode */
  hide?: string[];
  /** Additional keys to hide in multi-select mode */
  multiHide?: string[];
  /** Whether to show simplified menu (only remove) in multi-select */
  simplified?: boolean;
}

/**
 * Creates the full set of image actions.
 * This replaces the duplicate definitions in SingleImageContextMenu, MultiImageContextMenu,
 * and the androidActionItems in Gallery.vue, AlbumDetail.vue, TaskDetail.vue.
 */
export function createImageActions(
  options: CreateImageActionsOptions = {}
): ActionItem<ImageInfo>[] {
  // 没办法，这样写最简单
  const uiStore = useUiStore();
  const t = (key: string) => i18n.global.t(key);
  const {
    removeText = t("common.delete"),
    hide = [],
    multiHide = [],
    simplified = false,
  } = options;

  const hideSet = new Set(hide);
  const multiHideSet = new Set(multiHide);

  // Single-select actions
  const singleActions: ActionItem<ImageInfo>[] = [
    {
      key: "detail",
      label: t("contextMenu.detail"),
      icon: InfoFilled,
      command: "detail",
      // On Android: only in "更多" submenu
      visible: () => !hideSet.has("detail") && !uiStore.isCompact,
    },
    {
      key: "favorite",
      label: (ctx: ActionContext<ImageInfo>) =>
        ctx.target?.favorite ? t("contextMenu.unfavorite") : t("contextMenu.favorite"),
      icon: (ctx: ActionContext<ImageInfo>) => ctx.target?.favorite ? StarFilled : Star,
      command: "favorite",
      visible: () => !hideSet.has("favorite"),
    },
    {
      key: "share",
      label: t("contextMenu.share"),
      icon: Share,
      command: "share",
      // 仅 Android 且单选时在「更多」子菜单中显示，顶层不展示
      visible: () => false,
    },
    {
      key: "copy",
      label: IS_WEB ? t("contextMenu.downloadImage") : t("contextMenu.copyImage"),
      icon: IS_WEB ? Download : DocumentCopy,
      command: IS_WEB ? "download" : "copy",
      visible: (ctx) => {
        if (hideSet.has("copy")) return false;
        const count = ctx.selectedCount ?? 1;
        if (uiStore.isCompact) return count > 1;
        if (IS_WEB) return count <= 20;
        return count === 1;
      },
      suffix: (ctx) => {
        if (!IS_WEB) return "";
        const count = ctx.selectedCount ?? 1;
        return count > 1 ? `(${count})` : "";
      },
    },
    {
      key: "open",
      label: t("contextMenu.open"),
      icon: FolderOpened,
      command: "open",
      visible: (ctx) => !hideSet.has("open") && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "openFolder",
      label: t("contextMenu.openFolder"),
      icon: Folder,
      command: "openFolder",
      // Hide on Android
      visible: (ctx) => !hideSet.has("openFolder") && !IS_ANDROID && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "wallpaper",
      label: IS_WEB ? t("contextMenu.background") : t("contextMenu.wallpaper"),
      icon: Picture,
      command: "wallpaper",
      visible: () => !hideSet.has("wallpaper"),
    },
    {
      key: "addToAlbum",
      label: t("contextMenu.addToAlbum"),
      icon: FolderAdd,
      command: "addToAlbum",
      // On Android single-select: only in more submenu
      visible: (ctx) => !hideSet.has("addToAlbum") && (!multiHideSet.has("addToAlbum") 
        || !ctx.selectedCount 
        || ctx.selectedCount === 1) && (!uiStore.isCompact || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
    },
    {
      key: "addToHidden",
      label: (ctx: ActionContext<ImageInfo>) =>
        ctx.target?.isHidden ? t("contextMenu.unhide") : t("contextMenu.hide"),
      icon: (ctx: ActionContext<ImageInfo>) => (ctx.target?.isHidden ? View : Hide),
      command: "addToHidden",
      // On Android single-select: only in more submenu
      visible: (ctx) =>
        !hideSet.has("addToHidden") &&
        (!uiStore.isCompact || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
    },
    {
      key: "more",
      label: t("contextMenu.more"),
      icon: More,
      command: "more",
      visible: (ctx) => {
        if (hideSet.has("more")) return false;
        // Show on Windows (single-select) or Android (single-select)
        return (IS_WINDOWS || uiStore.isCompact) && (!ctx.selectedCount || ctx.selectedCount === 1);
      },
      children: uiStore.isCompact
        ? [
            {
              key: "detail",
              label: t("contextMenu.detail"),
              icon: InfoFilled,
              command: "detail",
              visible: () => !hideSet.has("detail"),
            },
            {
              key: "share",
              label: t("contextMenu.share"),
              icon: Share,
              command: "share",
              visible: () => !hideSet.has("share"),
            },
            {
              key: "copy",
              label: IS_WEB ? t("contextMenu.downloadImage") : t("contextMenu.copyImage"),
              icon: IS_WEB ? Download : DocumentCopy,
              command: IS_WEB ? "download" : "copy",
              visible: () => !hideSet.has("copy"),
            },
            {
              key: "addToAlbum",
              label: t("contextMenu.addToAlbum"),
              icon: FolderAdd,
              command: "addToAlbum",
              visible: () => !hideSet.has("addToAlbum"),
            },
            {
              key: "addToHidden",
              label: (ctx: ActionContext<ImageInfo>) =>
                ctx.target?.isHidden ? t("contextMenu.unhide") : t("contextMenu.hide"),
              icon: (ctx: ActionContext<ImageInfo>) => (ctx.target?.isHidden ? View : Hide),
              command: "addToHidden",
              visible: () => !hideSet.has("addToHidden"),
            },
            {
              key: "remove",
              label: removeText,
              icon: Delete,
              command: "remove",
              dividerBefore: true,
              visible: () => !hideSet.has("remove"),
            },
          ]
        : IS_WINDOWS
        ? [
            {
              key: "exportToWEAuto",
              label: t("contextMenu.exportToWE"),
              icon: Download,
              command: "exportToWEAuto",
              visible: () => !hideSet.has("exportToWEAuto"),
            },
          ]
        : [],
    },
    {
      key: "remove",
      label: removeText,
      icon: Delete,
      command: "remove",
      dividerBefore: true,
      // On Android single-select: only in more submenu
      visible: (ctx) => !hideSet.has("remove") && (!uiStore.isCompact || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
      suffix: (ctx) => {
        const count = ctx.selectedCount ?? 1;
        return count > 1 ? `(${count})` : "";
      },
    },
  ];

  // Multi-select actions (when selectedCount > 1)
  const multiActions: ActionItem<ImageInfo>[] = [
    {
      key: "favorite",
      label: (ctx) => {
        const target = ctx.target as ImageInfo | null;
        return target?.favorite ? t("contextMenu.unfavorite") : t("contextMenu.favorite");
      },
      icon: (ctx: ActionContext<ImageInfo>) => {
        const target = ctx.target as ImageInfo | null;
        return target?.favorite ? StarFilled : Star;
      },
      command: "favorite",
      visible: (ctx) => {
        if (hideSet.has("favorite") || multiHideSet.has("favorite")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
      suffix: (ctx) => ctx.selectedCount && ctx.selectedCount > 1 ? `(${ctx.selectedCount})` : "",
    },
    {
      key: "addToAlbum",
      label: t("contextMenu.addToAlbum"),
      icon: FolderAdd,
      command: "addToAlbum",
      visible: (ctx) => {
        if (hideSet.has("addToAlbum") || multiHideSet.has("addToAlbum")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
      suffix: (ctx) => ctx.selectedCount && ctx.selectedCount > 1 ? `(${ctx.selectedCount})` : "",
    },
    {
      key: "addToHidden",
      label: (ctx) => {
        const target = ctx.target as ImageInfo | null;
        return target?.isHidden ? t("contextMenu.unhide") : t("contextMenu.hide");
      },
      icon: (ctx: ActionContext<ImageInfo>) => {
        const target = ctx.target as ImageInfo | null;
        return target?.isHidden ? View : Hide;
      },
      command: "addToHidden",
      visible: (ctx) => {
        if (hideSet.has("addToHidden") || multiHideSet.has("addToHidden")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
      suffix: (ctx) => ctx.selectedCount && ctx.selectedCount > 1 ? `(${ctx.selectedCount})` : "",
    },
    {
      key: "wallpaper",
      label: IS_WEB ? t("contextMenu.background") : t("contextMenu.wallpaper"),
      icon: Picture,
      command: "wallpaper",
      visible: (ctx) => {
        if (hideSet.has("wallpaper")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
    },
    {
      key: "remove",
      label: removeText,
      icon: Delete,
      command: "remove",
      dividerBefore: true,
      visible: (ctx) => {
        if (hideSet.has("remove")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
      suffix: (ctx) => ctx.selectedCount && ctx.selectedCount > 1 ? `(${ctx.selectedCount})` : "",
    },
  ];

  // Return combined actions - visibility logic will filter appropriately
  if (simplified) {
    // Simplified mode: only show remove
    return singleActions.filter((item) => item.key === "remove");
  }

  // Combine single and multi actions - visibility predicates handle the filtering
  const allActions = [...singleActions];
  
  // Add multi-select specific actions (they'll be filtered by visibility)
  for (const multiAction of multiActions) {
    const existingIndex = allActions.findIndex((a) => a.key === multiAction.key);
    if (existingIndex >= 0) {
      // Merge visibility logic
      const existing = allActions[existingIndex]!;
      const originalVisible = existing.visible;
      const multiVisible = multiAction.visible;
      allActions[existingIndex] = {
        ...existing,
        visible: (ctx) => {
          if (originalVisible && !originalVisible(ctx)) return false;
          if (multiVisible && multiVisible(ctx)) return true;
          return originalVisible ? originalVisible(ctx) : false;
        },
        // Use multi-select suffix if available
        suffix: multiAction.suffix || existing.suffix,
      };
    } else {
      allActions.push(multiAction);
    }
  }

  return allActions;
}
