import {
  Folder,
  FolderCheck,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Network,
  Pause,
  Pencil,
  RefreshCw,
  Tag,
  Trash2,
} from "@lucide/vue";
import type { ActionItem, ActionContext } from "@/actions/types";
import { HIDDEN_ALBUM_ID, type Album } from "@/services/albums";
import { i18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import type { AlbumSyncMode } from "@/types/album";
import { syncModeIcon } from "@/utils/albumSyncMode";

/** 本地文件夹同步仅桌面端支持（排除 Android 与 Web）。 */
const LOCAL_FOLDER_SUPPORTED = !IS_ANDROID && !IS_WEB;

/**
 * Extended context for album actions (context menu / action sheet on Albums page).
 * Must include ActionContext<Album> so ActionRenderer receives compatible context.
 */
export interface AlbumActionContext extends ActionContext<Album> {
  /** 活跃壁纸目标里轮播路径直接以画册为根的那些画册 id */
  rotationAlbumIds: readonly string[];
  /** 其中每个活跃壁纸目标都在轮播的画册 id（只有一个目标时与上面相同） */
  fullRotationAlbumIds: readonly string[];
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
  isLocalFolder: boolean;
  /** 标签画册：多出「修改 key」 */
  isLabel: boolean;
  /** 标签目录：允许新建子标签/子目录，但不能放图片。 */
  isLabelDir: boolean;
  /** 虚拟盘门禁（宿主已算好：Albums.vue albumDriveEnabled） */
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
      icon: FolderOpen,
      command: "browse",
      visible: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "createSubAlbum",
      label: t("contextMenu.createSubAlbum"),
      icon: FolderPlus,
      command: "createSubAlbum",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        // 收藏/隐藏画册与本地文件夹画册（子册由磁盘目录唯一决定）不能手动新建子画册
        return (
          ext.target?.id !== ext.favoriteAlbumId &&
          ext.target?.id !== HIDDEN_ALBUM_ID &&
          !ext.isLocalFolder &&
          !ext.isLabel &&
          !ext.isLabelDir
        );
      },
    },
    {
      key: "createLabelChild",
      label: t("contextMenu.createSubAlbum"),
      icon: FolderPlus,
      visible: (ctx) => (ctx as AlbumActionContext).isLabelDir,
      children: [
        {
          key: "createSubLabel",
          label: t("albums.treeAddLabel"),
          icon: Tag,
          command: "createSubLabel",
        },
        {
          key: "createSubLabelDir",
          label: t("albums.treeAddLabelDir"),
          icon: Folder,
          command: "createSubLabelDir",
        },
      ],
    },
    {
      key: "openVirtualDrive",
      label: t("contextMenu.openVirtualDrive"),
      icon: FolderOpen,
      command: "openVirtualDrive",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.albumDriveEnabled && ext.target?.id !== HIDDEN_ALBUM_ID;
      },
    },
    {
      key: "syncNow",
      label: t("contextMenu.syncNow"),
      icon: RefreshCw,
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
      children: [
        {
          key: "syncFolderOnly",
          label: t("contextMenu.syncFolderOnly"),
          icon: RefreshCw,
          command: "syncNow",
        },
        {
          key: "syncNowRecursiveExisting",
          label: t("contextMenu.syncNowRecursiveExisting"),
          icon: RefreshCw,
          command: "syncNowRecursiveExisting",
        },
        {
          key: "syncNowRecursiveFull",
          label: t("contextMenu.syncNowRecursiveFull"),
          icon: RefreshCw,
          command: "syncNowRecursiveFull",
        },
      ],
    },
    {
      key: "setSyncMode",
      label: t("contextMenu.setSyncMode"),
      icon: Network,
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      disabled: (ctx) => ctx.target?.syncMode === "delegated",
      suffix: (ctx) => (ctx.target?.syncMode === "delegated" ? t("contextMenu.syncModeDelegatedReason") : ""),
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
      key: "convertToNormal",
      label: t("contextMenu.convertToNormalAlbum"),
      icon: FolderCheck,
      command: "convertToNormal",
      dividerBefore: true,
      visible: (ctx) => LOCAL_FOLDER_SUPPORTED && (ctx as AlbumActionContext).isLocalFolder,
      disabled: (ctx) => ctx.target?.syncMode === "delegated",
      suffix: (ctx) => (ctx.target?.syncMode === "delegated" ? t("contextMenu.convertDelegatedReason") : ""),
    },
    {
      key: "setWallpaperRotation",
      label: t("contextMenu.setWallpaperRotation"),
      icon: ImageIcon,
      command: "setWallpaperRotation",
      // 多块屏逐屏独立时，只要还有屏没在轮播这个画册就仍可设（给另一块屏）；每块屏都在轮播它才收起
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        const everywhere =
          ext.wallpaperRotationEnabled && ext.target && ext.fullRotationAlbumIds.includes(ext.target.id);
        return ext.albumImageCount > 0 && !everywhere;
      },
    },
    {
      key: "stopWallpaperRotation",
      label: t("contextMenu.stopWallpaperRotation"),
      icon: Pause,
      command: "stopWallpaperRotation",
      // 任一块屏在轮播这个画册就给出；关的是全局的轮播开关
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return !!ext.wallpaperRotationEnabled && !!ext.target && ext.rotationAlbumIds.includes(ext.target.id);
      },
    },
    {
      key: "rename",
      label: t("contextMenu.rename"),
      icon: Pencil,
      command: "rename",
      visible: () => true,
      dividerBefore: (ctx) => (ctx as AlbumActionContext).albumImageCount > 0,
    },
    {
      key: "setLabelKey",
      label: t("contextMenu.setLabelKey"),
      icon: Tag,
      command: "setLabelKey",
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.isLabel || ext.isLabelDir;
      },
    },
    {
      key: "moveTo",
      label: t("contextMenu.moveTo"),
      icon: FolderInput,
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
      icon: Trash2,
      command: "delete",
      dividerBefore: true,
      visible: (ctx) => {
        const ext = ctx as AlbumActionContext;
        return ext.target?.id !== ext.favoriteAlbumId;
      },
    },
  ];
}
