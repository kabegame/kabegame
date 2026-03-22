import { FolderOpened, Picture, Edit, Delete } from "@element-plus/icons-vue";
import type { ActionItem, ActionContext } from "@kabegame/core/actions/types";
import type { Album } from "@/stores/albums";
import { i18n } from "@kabegame/i18n";

/**
 * Extended context for album actions (context menu / action sheet on Albums page).
 * Must include ActionContext<Album> so ActionRenderer receives compatible context.
 */
export interface AlbumActionContext extends ActionContext<Album> {
  currentRotationAlbumId: string | null;
  wallpaperRotationEnabled: boolean;
  albumImageCount: number;
  favoriteAlbumId: string;
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
