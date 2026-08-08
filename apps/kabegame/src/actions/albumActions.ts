import { Connection, FolderOpened, Folder, FolderAdd, Picture, Edit, Rank, Delete, Refresh, VideoPause } from "@kabegame/element-plus-icons";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import { HIDDEN_ALBUM_ID } from "@/stores/albums";
import type { Album } from "@/stores/albums";
import { i18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@kabegame/core/env";
import type { AlbumSyncMode } from "@kabegame/core/types/album";
import { syncModeIcon } from "@/utils/albumSyncMode";

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
  /** 虚拟盘门禁（宿主已各自算好：Albums.vue albumDriveEnabled / AlbumDetail.vue albumDriveEnabled） */
  albumDriveEnabled: boolean;
}

/**
 * Creates album actions for ActionRenderer (desktop ContextMenu / Android ActionSheet).
 * Replaces the legacy AlbumContextMenu.vue menu items.
 */
export function createAlbumActions(): ActionItem<Album>[] {
  const t = (key: string) => i18n.global.t(key);
  const currentModeSuffix = (mode: AlbumSyncMode) => (ctx: ActionContext<Album>) =>
    ctx.target?.syncMode === mode ? t("contextMenu.syncModeCurrent") : "";
  return [
    {
      key: "browse",
      label: t("contextMenu.browse"),
      icon: FolderOpened,
      command: "browse",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "createSubAlbum",
      label: t("contextMenu.createSubAlbum"),
      icon: FolderAdd,
      command: "createSubAlbum",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        // 收藏/隐藏画册与本地文件夹画册（子册由磁盘目录唯一决定）不能手动新建子画册
        return (
          ext.target?.id !== ext.favoriteAlbumId &&
          ext.target?.id !== HIDDEN_ALBUM_ID &&
          !ext.isLocalFolder
        );
      },
    },
    {
      key: "openVirtualDrive",
      label: t("contextMenu.openVirtualDrive"),
      icon: FolderOpened,
      command: "openVirtualDrive",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.albumDriveEnabled && ext.target?.id !== HIDDEN_ALBUM_ID;
      },
    },
    {
      key: "syncNow",
      label: t("contextMenu.syncNow"),
      icon: Refresh,
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
      children: [
        {
          key: "syncFolderOnly",
          label: t("contextMenu.syncFolderOnly"),
          icon: Refresh,
          command: "syncNow",
        },
        {
          key: "syncNowRecursiveExisting",
          label: t("contextMenu.syncNowRecursiveExisting"),
          icon: Refresh,
          command: "syncNowRecursiveExisting",
        },
        {
          key: "syncNowRecursiveFull",
          label: t("contextMenu.syncNowRecursiveFull"),
          icon: Refresh,
          command: "syncNowRecursiveFull",
        },
      ],
    },
    {
      key: "setSyncMode",
      label: t("contextMenu.setSyncMode"),
      icon: Connection,
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      disabled: (ctx) => ctx.target?.syncMode === "delegated",
      suffix: (ctx) =>
        ctx.target?.syncMode === "delegated"
          ? t("contextMenu.syncModeDelegatedReason")
          : "",
      children: [
        {
          key: "setSyncModeNone",
          label: t("contextMenu.syncModeNone"),
          command: "setSyncMode:none",
          suffix: currentModeSuffix("none"),
        },
        {
          key: "setSyncModeShallow",
          label: t("contextMenu.syncModeShallow"),
          icon: syncModeIcon("shallow")!,
          command: "setSyncMode:shallow",
          suffix: currentModeSuffix("shallow"),
        },
        {
          key: "setSyncModeRecursive",
          label: t("contextMenu.syncModeRecursive"),
          icon: syncModeIcon("recursive")!,
          command: "setSyncMode:recursive",
          suffix: currentModeSuffix("recursive"),
        },
        {
          key: "setSyncModeDelegated",
          label: t("contextMenu.syncModeDelegated"),
          icon: syncModeIcon("delegated")!,
          command: "setSyncMode:delegated",
          disabled: true,
          suffix: currentModeSuffix("delegated"),
        },
      ],
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
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        const isCurrent =
          ext.wallpaperRotationEnabled &&
          ext.target &&
          ext.currentRotationAlbumId === ext.target.id;
        return ext.albumImageCount > 0 && !isCurrent;
      },
    },
    {
      key: "stopWallpaperRotation",
      label: t("contextMenu.stopWallpaperRotation"),
      icon: VideoPause,
      command: "stopWallpaperRotation",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return !!ext.wallpaperRotationEnabled && !!ext.target && ext.currentRotationAlbumId === ext.target.id;
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
        // 本地文件夹画册的位置由其磁盘路径唯一决定，不能手动移动（后端亦有同款守卫兜底）
        return ext.target?.id !== ext.favoriteAlbumId && !ext.isLocalFolder;
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
