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
} from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { ImageInfo } from "@/stores/crawler";
import { IS_WINDOWS, IS_ANDROID } from "@kabegame/core/env";

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
  const {
    removeText = "删除",
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
      label: "详情",
      icon: InfoFilled,
      command: "detail",
      visible: (ctx) => !hideSet.has("detail"),
    },
    {
      key: "favorite",
      label: (ctx: ActionContext<ImageInfo>) => ctx.target?.favorite ? "取消收藏" : "收藏",
      icon: (ctx: ActionContext<ImageInfo>) => ctx.target?.favorite ? StarFilled : Star,
      command: "favorite",
      visible: (ctx) => !hideSet.has("favorite") && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "share",
      label: "分享",
      icon: Share,
      command: "share",
      // Only show on Android and single-select
      visible: (ctx) => !hideSet.has("share") && IS_ANDROID && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "copy",
      label: "复制图片",
      icon: DocumentCopy,
      command: "copy",
      // On Android, only in more submenu (single-select) or top level (multi-select)
      visible: (ctx) => !hideSet.has("copy") && (!ctx.selectedCount || ctx.selectedCount === 1) && (!IS_ANDROID || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
    },
    {
      key: "open",
      label: "仔细欣赏",
      icon: FolderOpened,
      command: "open",
      // Hide on Android
      visible: (ctx) => !hideSet.has("open") && !IS_ANDROID && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "openFolder",
      label: "欣赏更多",
      icon: Folder,
      command: "openFolder",
      // Hide on Android
      visible: (ctx) => !hideSet.has("openFolder") && !IS_ANDROID && (!ctx.selectedCount || ctx.selectedCount === 1),
    },
    {
      key: "wallpaper",
      label: "抱到桌面上",
      icon: Picture,
      command: "wallpaper",
      visible: (ctx) => !hideSet.has("wallpaper"),
    },
    {
      key: "addToAlbum",
      label: "加入画册",
      icon: FolderAdd,
      command: "addToAlbum",
      // On Android single-select: only in more submenu
      visible: (ctx) => !hideSet.has("addToAlbum") && (!multiHideSet.has("addToAlbum") || !ctx.selectedCount || ctx.selectedCount === 1) && (!IS_ANDROID || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
    },
    {
      key: "more",
      label: "更多",
      icon: More,
      command: "more",
      visible: (ctx) => {
        if (hideSet.has("more")) return false;
        // Show on Windows (single-select) or Android (single-select)
        return (IS_WINDOWS || IS_ANDROID) && (!ctx.selectedCount || ctx.selectedCount === 1);
      },
      children: IS_ANDROID
        ? [
            {
              key: "copy",
              label: "复制图片",
              icon: DocumentCopy,
              command: "copy",
              visible: () => !hideSet.has("copy"),
            },
            {
              key: "addToAlbum",
              label: "加入画册",
              icon: FolderAdd,
              command: "addToAlbum",
              visible: () => !hideSet.has("addToAlbum"),
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
              label: "导出到wallpaper engine",
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
      visible: (ctx) => !hideSet.has("remove") && (!IS_ANDROID || (ctx.selectedCount !== undefined && ctx.selectedCount > 1)),
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
        // Check if any selected images are not favorited
        const target = ctx.target as ImageInfo | null;
        return target?.favorite ? "取消收藏" : "收藏";
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
      label: "加入画册",
      icon: FolderAdd,
      command: "addToAlbum",
      visible: (ctx) => {
        if (hideSet.has("addToAlbum") || multiHideSet.has("addToAlbum")) return false;
        return ctx.selectedCount !== undefined && ctx.selectedCount > 1;
      },
      suffix: (ctx) => ctx.selectedCount && ctx.selectedCount > 1 ? `(${ctx.selectedCount})` : "",
    },
    {
      key: "wallpaper",
      label: "抱到桌面上",
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
