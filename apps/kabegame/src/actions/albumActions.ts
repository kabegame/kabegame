import { FolderOpened, Folder, Picture, Edit, Rank, Delete, Refresh } from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { Album } from "@/stores/albums";
import { i18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";

/** 本地文件夹同步仅桌面端支持（排除 Android 与 Web）。 */
const LOCAL_FOLDER_SUPPORTED = !IS_ANDROID && !IS_WEB;

/**
 * Extended context for album actions (context menu / action sheet on Albums page).
 * Must include ActionContext<Album> so ActionRenderer receives compatible context.
 */
export interface AlbumActionContext extends ActionContext<Album> {
  currentRotationAlbumId: string | null;
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
  isLocalFolder: boolean;
}

/**
 * Creates album actions for ActionRenderer (desktop ContextMenu / Android ActionSheet).
 * Replaces the legacy AlbumContextMenu.vue menu items.
 */
export function createAlbumActions(): ActionItem<Album>[] {
  const t = (key: string) => i18n.global.t(key);
  return [
    {
      key: "browse",
      label: t("contextMenu.browse"),
      icon: FolderOpened,
      command: "browse",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "syncNow",
      label: t("contextMenu.syncNow"),
      icon: Refresh,
      command: "syncNow",
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "syncNowRecursive",
      label: t("contextMenu.syncNowRecursive"),
      icon: Refresh,
      command: "syncNowRecursive",
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
    },
    {
      key: "openLocalFolder",
      label: t("contextMenu.openLocalFolder"),
      icon: Folder,
      command: "openLocalFolder",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return LOCAL_FOLDER_SUPPORTED && ext.isLocalFolder && !!ext.target?.syncFolder;
      },
    },
    {
      key: "setWallpaperRotation",
      label: t("contextMenu.setWallpaperRotation"),
      icon: Picture,
      command: "setWallpaperRotation",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
      suffix: (ctx) => {
        const ext = ctx as AlbumActionContext;
        const isCurrent =
          ext.wallpaperRotationEnabled &&
          ext.target &&
          ext.currentRotationAlbumId === ext.target.id;
        return isCurrent ? t("contextMenu.setWallpaperRotationActive") : "";
      },
    },
    {
      key: "rename",
      label: t("contextMenu.rename"),
      icon: Edit,
      command: "rename",
      visible: () => true,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "moveTo",
      label: t("contextMenu.moveTo"),
      icon: Rank,
      command: "moveTo",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.target?.id !== ext.favoriteAlbumId;
      },
    },
    {
      key: "delete",
      label: t("common.delete"),
      icon: Delete,
      command: "delete",
      dividerBefore: true,
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.target?.id !== ext.favoriteAlbumId;
      },
    },
  ];
}
